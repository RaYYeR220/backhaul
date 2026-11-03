// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {BackhaulOrder, BackhaulOrders} from "./BackhaulOrder.sol";
import {DestinationSettler} from "./DestinationSettler.sol";
import {outboxKey} from "../core/Outbox.sol";
import {IRemoteVerifier} from "../interfaces/IRemoteVerifier.sol";

/// @title LPVault
/// @notice Pooled solver inventory on the destination chain. LPs deposit `asset` for shares, and
/// the pool fills orders through the DestinationSettler; the fee comes back with the repayment.
///
/// There is no operator. Anyone may trigger `fill`, and it goes through only for an order that
/// - is proven open on the origin chain: the remote OriginSettler committed it to its Outbox,
///   checked through this chain's light-client verifier,
/// - pays out this vault's asset,
/// - is paid for in the pinned input token on the pinned origin chain, and
/// - pays at least `minFeeBps` over the output.
/// The repayment is always committed to `remoteVault`, a RepayForwarder on the origin chain that
/// sends it back here over the canonical bridge. Nobody can move LP funds any other way.
///
/// Accounting: `idle` is the asset the vault has counted; `pendingRepay` is principal sent out on
/// fills and not back yet. Anything above `idle` in the balance is new money: it first pays down
/// `pendingRepay`, the rest (the fee) is a gain. So a fill leaves the share price flat and the gain
/// only shows once the repayment has actually arrived.
///
/// A gain vests linearly over {VESTING_PERIOD}. Anyone can make a repayment land (the gateways'
/// `finalize` is permissionless), so without vesting a deposit just before the landing and a
/// withdrawal just after, in one transaction, would take a share of a fee the pool earned before
/// that capital arrived. Deposits buy shares at the full value, {totalAssets} with the unvested
/// gain in it; withdrawals pay out of the vested value only, {totalAssets} minus {lockedGain}. So
/// such a round trip gets nothing of the gain, a late depositor never dilutes a gain that has
/// landed, and an LP who leaves while a gain is still vesting leaves the unvested part of it to the
/// LPs who stay.
contract LPVault {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /// virtual shares against the first-depositor donation trick
    uint256 internal constant VIRTUAL_SHARES = 1e6;
    /// @notice A realized gain vests linearly over this many seconds.
    uint256 public constant VESTING_PERIOD = 6 hours;

    address public immutable asset; // address(0) = native
    DestinationSettler public immutable dst;
    IRemoteVerifier public immutable verifier; // proves the origin chain
    uint16 public immutable minFeeBps;
    address private immutable _deployer;

    address public remoteVault;
    uint64 public originChainId;
    address public remoteOriginSettler;
    address public remoteAsset;

    uint128 public idle;
    uint128 public pendingRepay;
    /// @dev One storage slot: the gain still unvested at `_lockedAt`, vesting linearly to zero at
    ///      `_unlockAt`.
    uint128 private _locked;
    uint64 private _lockedAt;
    uint64 private _unlockAt;
    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;

    event Deposit(address indexed lp, uint256 assets, uint256 shares);
    event Withdraw(address indexed lp, uint256 assets, uint256 shares);
    event VaultFill(bytes32 indexed orderId, uint256 outputAmount, uint256 inputAmount);
    event Repaid(uint256 principal, uint256 gain);
    event RemoteSet(address remoteVault, address remoteOriginSettler, address remoteAsset, uint64 originChainId);

    error InvalidProof();
    error NotDeployer();
    error RemoteAlreadySet();
    error NotWired();
    error ZeroAddress();
    error WrongAsset();
    error WrongRoute();
    error Unprofitable();
    error InsufficientIdle();
    error InsufficientShares();
    error ZeroAmount();
    error ZeroShares();
    error WrongValue();
    error InputMismatch();
    error NativeNotAccepted();
    error NativeTransferFailed();

    constructor(address asset_, DestinationSettler dst_, IRemoteVerifier verifier_, uint16 minFeeBps_) {
        asset = asset_;
        dst = dst_;
        verifier = verifier_;
        minFeeBps = minFeeBps_;
        _deployer = msg.sender;
    }

    /// @notice One-time wiring: where repayments land on the origin chain, which settler opens
    ///         orders there, which token pays for them, and which chain that is. Locked forever.
    function setRemote(address remoteVault_, address remoteOriginSettler_, address remoteAsset_, uint64 originChainId_)
        external
    {
        if (msg.sender != _deployer) revert NotDeployer();
        if (remoteVault_ == address(0) || remoteOriginSettler_ == address(0) || originChainId_ == 0) {
            revert ZeroAddress();
        }
        if (remoteVault != address(0)) revert RemoteAlreadySet();
        remoteVault = remoteVault_;
        originChainId = originChainId_;
        remoteOriginSettler = remoteOriginSettler_;
        remoteAsset = remoteAsset_;
        emit RemoteSet(remoteVault_, remoteOriginSettler_, remoteAsset_, originChainId_);
    }

    // ---------------------------------------------------------------- LPs

    function deposit(uint256 assets) external payable returns (uint256 shares) {
        if (asset == address(0)) {
            if (msg.value != assets) revert WrongValue();
        } else if (msg.value != 0) {
            revert WrongValue();
        }
        _sync(msg.value);
        if (assets == 0) revert ZeroAmount();
        shares = assets * (totalShares + VIRTUAL_SHARES) / (uint256(idle) + pendingRepay + 1);
        if (shares == 0) revert ZeroShares();

        if (asset != address(0)) {
            IERC20 token = IERC20(asset);
            uint256 before = token.balanceOf(address(this));
            token.safeTransferFrom(msg.sender, address(this), assets);
            if (token.balanceOf(address(this)) - before != assets) revert InputMismatch();
        }
        totalShares += shares;
        sharesOf[msg.sender] += shares;
        idle = (uint256(idle) + assets).toUint128();
        emit Deposit(msg.sender, assets, shares);
    }

    function withdraw(uint256 shares) external returns (uint256 assets) {
        if (shares == 0 || shares > sharesOf[msg.sender]) revert InsufficientShares();
        _sync(0);
        uint256 cash = idle;
        uint256 vested = cash + pendingRepay;
        uint256 locked = lockedGain();
        vested = vested > locked ? vested - locked : 0;
        assets = shares * (vested + 1) / (totalShares + VIRTUAL_SHARES);
        if (assets > cash) revert InsufficientIdle();
        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        // forge-lint: disable-next-line(unsafe-typecast)
        idle = uint128(cash - assets); // below the old uint128 value
        _send(msg.sender, assets);
        emit Withdraw(msg.sender, assets, shares);
    }

    // ---------------------------------------------------------------- fills

    /// @notice Fills an order from the pool. Permissionless: the order must be proven open on the
    ///         origin chain, and the repayment always goes to `remoteVault`.
    /// @param openProof proof, for `verifier`, that the remote OriginSettler committed
    ///        keccak256(originData) under `orderId` in the origin Outbox
    function fill(bytes32 orderId, bytes calldata originData, bytes calldata openProof) external {
        address repayTo = remoteVault;
        if (repayTo == address(0)) revert NotWired();
        (bytes32 id, BackhaulOrder memory o, uint64 fromChain,) = BackhaulOrders.decode(originData);
        if (o.outputToken != asset) revert WrongAsset();
        if (o.inputToken != remoteAsset || fromChain != originChainId) revert WrongRoute();
        if (o.inputAmount * 10_000 < o.outputAmount * (10_000 + uint256(minFeeBps))) revert Unprofitable();
        // `id` is the canonical keccak256(originData); a mismatched `orderId` has no such commitment
        if (!verifier.verifyCommitment(outboxKey(remoteOriginSettler, orderId), id, openProof)) {
            revert InvalidProof();
        }

        _sync(0);
        uint256 out = o.outputAmount;
        uint256 cash = idle;
        if (out > cash) revert InsufficientIdle();
        // forge-lint: disable-next-line(unsafe-typecast)
        idle = uint128(cash - out); // below the old uint128 value
        pendingRepay = (uint256(pendingRepay) + out).toUint128();

        if (asset == address(0)) {
            dst.fill{value: out}(orderId, originData, abi.encode(repayTo));
        } else {
            // the settler only ever pulls from its caller, so a standing approval is safe
            // (and avoids paying a fresh pallet-assets approval deposit on every fill)
            IERC20 token = IERC20(asset);
            if (token.allowance(address(this), address(dst)) < out) {
                token.forceApprove(address(dst), type(uint256).max);
            }
            dst.fill(orderId, originData, abi.encode(repayTo));
        }
        emit VaultFill(orderId, out, o.inputAmount);
    }

    // ---------------------------------------------------------------- repayments

    /// @notice Counts asset that arrived since the last sync (repayments come home over the
    ///         canonical bridge, which can't call back for ERC-20s). Anyone may call.
    function notifyRepaid() external {
        _sync(0);
    }

    receive() external payable {
        if (asset != address(0)) revert NativeNotAccepted();
        _sync(0);
    }

    /// @notice Everything the pool owns, with any unvested gain; what a deposit buys into.
    function totalAssets() external view returns (uint256) {
        (uint256 cash, uint256 pending) = _synced(0);
        return cash + pending;
    }

    /// @notice The part of past gains that has not vested yet: withdrawals leave it in the pool.
    /// @dev A gain that arrives but is not synced yet is not in it (a withdrawal syncs first).
    function lockedGain() public view returns (uint256) {
        (uint256 locked,) = _lockedNow();
        return locked;
    }

    function _sync(uint256 incoming) private {
        (uint256 cash, uint256 pending) = _synced(incoming);
        uint256 oldCash = idle;
        if (cash == oldCash) return;
        uint256 principal = pendingRepay - pending;
        uint256 gain = cash - oldCash - principal;
        idle = cash.toUint128();
        // forge-lint: disable-next-line(unsafe-typecast)
        pendingRepay = uint128(pending); // never above the old value
        if (gain != 0) _lock(gain);
        emit Repaid(principal, gain);
    }

    /// @dev Adds `gain` to the unvested amount. The new unlock time is the amount-weighted average
    ///      of what is left of the old one and a full period for the new gain, so a dust gain
    ///      cannot hold back the vesting of a large one.
    function _lock(uint256 gain) private {
        (uint256 locked, uint256 left) = _lockedNow();
        uint256 total = locked + gain;
        uint256 duration = (locked * left + gain * VESTING_PERIOD) / total; // ≥ 1: left ≥ 1 when locked > 0
        _locked = total.toUint128();
        // forge-lint: disable-next-line(unsafe-typecast)
        _lockedAt = uint64(block.timestamp); // seconds
        // forge-lint: disable-next-line(unsafe-typecast)
        _unlockAt = uint64(block.timestamp + duration); // duration ≤ VESTING_PERIOD
    }

    /// @dev The unvested gain now, and the seconds until it has all vested.
    function _lockedNow() private view returns (uint256 locked, uint256 left) {
        uint256 end = _unlockAt;
        if (block.timestamp >= end) return (0, 0);
        left = end - block.timestamp;
        locked = uint256(_locked) * left / (end - _lockedAt);
    }

    /// @param incoming native value of the current call, not yet counted
    function _synced(uint256 incoming) private view returns (uint256 cash, uint256 pending) {
        cash = idle;
        pending = pendingRepay;
        uint256 bal = _balance() - incoming;
        if (bal <= cash) return (cash, pending);
        uint256 surplus = bal - cash;
        uint256 principal = surplus < pending ? surplus : pending;
        return (bal, pending - principal);
    }

    function _balance() private view returns (uint256) {
        return asset == address(0) ? address(this).balance : IERC20(asset).balanceOf(address(this));
    }

    function _send(address to, uint256 amount) private {
        if (asset == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(asset).safeTransfer(to, amount);
        }
    }
}
