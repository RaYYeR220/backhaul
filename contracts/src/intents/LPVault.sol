// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {BackhaulOrder} from "./BackhaulOrder.sol";
import {DestinationSettler} from "./DestinationSettler.sol";

/// @title LPVault
/// @notice Pooled solver inventory on the destination chain. LPs deposit `asset` for shares; an
/// operator key fills orders from the pool through the DestinationSettler, and the fee comes back
/// with the repayment.
///
/// The operator can only `fill`, and only orders that
/// - pay out this vault's asset,
/// - are paid for in the pinned input token on the pinned origin chain, and
/// - pay at least `minFeeBps` over the output.
/// The repayment is always committed to `remoteVault`, a RepayForwarder on the origin chain that
/// sends it back here over the canonical bridge. The operator has no withdraw path.
///
/// Accounting: `idle` is the asset the vault has counted; `pendingRepay` is principal sent out on
/// fills and not back yet. Anything above `idle` in the balance is new money: it first pays down
/// `pendingRepay`, the rest (the fee) raises the share price. So a fill leaves the share price
/// flat and the gain only shows once the repayment has actually arrived.
contract LPVault {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /// virtual shares against the first-depositor donation trick
    uint256 internal constant VIRTUAL_SHARES = 1e6;

    address public immutable asset; // address(0) = native
    DestinationSettler public immutable dst;
    address public immutable operator;
    uint16 public immutable minFeeBps;
    address private immutable _deployer;

    address public remoteVault;
    uint64 public originChainId;
    address public remoteAsset;

    uint128 public idle;
    uint128 public pendingRepay;
    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;

    event Deposit(address indexed lp, uint256 assets, uint256 shares);
    event Withdraw(address indexed lp, uint256 assets, uint256 shares);
    event VaultFill(bytes32 indexed orderId, uint256 outputAmount, uint256 inputAmount);
    event Repaid(uint256 principal, uint256 gain);
    event RemoteSet(address remoteVault, address remoteAsset, uint64 originChainId);

    error NotOperator();
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

    constructor(address asset_, DestinationSettler dst_, address operator_, uint16 minFeeBps_) {
        asset = asset_;
        dst = dst_;
        operator = operator_;
        minFeeBps = minFeeBps_;
        _deployer = msg.sender;
    }

    /// @notice One-time wiring: where repayments land on the origin chain, which token they come
    ///         in, and which chain that is. Locked forever once set.
    function setRemote(address remoteVault_, address remoteAsset_, uint64 originChainId_) external {
        if (msg.sender != _deployer) revert NotDeployer();
        if (remoteVault_ == address(0) || originChainId_ == 0) revert ZeroAddress();
        if (remoteVault != address(0)) revert RemoteAlreadySet();
        remoteVault = remoteVault_;
        originChainId = originChainId_;
        remoteAsset = remoteAsset_;
        emit RemoteSet(remoteVault_, remoteAsset_, originChainId_);
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
        assets = shares * (cash + pendingRepay + 1) / (totalShares + VIRTUAL_SHARES);
        if (assets > cash) revert InsufficientIdle();
        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        // forge-lint: disable-next-line(unsafe-typecast)
        idle = uint128(cash - assets); // below the old uint128 value
        _send(msg.sender, assets);
        emit Withdraw(msg.sender, assets, shares);
    }

    // ---------------------------------------------------------------- operator

    function fill(bytes32 orderId, bytes calldata originData) external {
        if (msg.sender != operator) revert NotOperator();
        address repayTo = remoteVault;
        if (repayTo == address(0)) revert NotWired();
        (BackhaulOrder memory o, uint64 fromChain,) = abi.decode(originData, (BackhaulOrder, uint64, uint32));
        if (o.outputToken != asset) revert WrongAsset();
        if (o.inputToken != remoteAsset || fromChain != originChainId) revert WrongRoute();
        if (o.inputAmount * 10_000 < o.outputAmount * (10_000 + uint256(minFeeBps))) revert Unprofitable();

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

    function totalAssets() external view returns (uint256) {
        (uint256 cash, uint256 pending) = _synced(0);
        return cash + pending;
    }

    function _sync(uint256 incoming) private {
        (uint256 cash, uint256 pending) = _synced(incoming);
        uint256 oldCash = idle;
        if (cash == oldCash) return;
        uint256 principal = pendingRepay - pending;
        idle = cash.toUint128();
        // forge-lint: disable-next-line(unsafe-typecast)
        pendingRepay = uint128(pending); // never above the old value
        emit Repaid(principal, cash - oldCash - principal);
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
