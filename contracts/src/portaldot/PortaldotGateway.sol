// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {GatewayBase} from "../core/GatewayBase.sol";
import {Outbox} from "../core/Outbox.sol";
import {Transfer, Transfers} from "../core/Transfer.sol";
import {IRemoteVerifier} from "../interfaces/IRemoteVerifier.sol";

/// @title PortaldotGateway
/// @notice Canonical bridge, Portaldot side.
/// - tPOT -> BSC: `lockPOT` escrows native tPOT (minus a 10 bps fee for the gas pool); BSC mints pPOT.
/// - pPOT -> Portaldot: `finalize` kind 2 releases escrowed tPOT.
/// - tBNB -> Portaldot: `finalize` kind 3 releases BNB.b, a pallet-assets asset whose whole fixed
///   supply this contract holds (used through the assets ERC-20 precompile).
/// - BNB.b -> BSC: `burnBNBb` takes BNB.b back into the contract; BSC releases tBNB.
/// @dev On revive, msg.value and balances are 18-decimal wei-units; tPOT has 14 decimals, so every
///      native amount is a multiple of 1e4. The contract balance is split into two buckets:
///      `lockedPOT` (escrow, owed to pPOT holders) and `gasPool()` (everything else).
contract PortaldotGateway is GatewayBase {
    using SafeERC20 for IERC20;

    uint256 public constant FEE_BPS = 10;
    /// tPOT sent along with BNB.b to an account that has none (0.5 tPOT: existential deposit + fees)
    uint256 public constant GAS_DROP = 0.5e18;
    /// smallest BNB.b release that earns a gas drop, so the pool can't be farmed with dust
    uint256 public constant GAS_DROP_MIN_AMOUNT = 1e15;
    /// one planck of tPOT in wei-units
    uint256 internal constant NATIVE_UNIT = 1e4;

    IERC20 public immutable bnbAsset;
    uint256 public lockedPOT;

    event GasDropped(address indexed recipient, uint256 amount);

    error Dust();
    error ExceedsLocked();

    constructor(Outbox outbox_, IRemoteVerifier verifier_, address bnbAsset_) GatewayBase(outbox_, verifier_) {
        bnbAsset = IERC20(bnbAsset_);
    }

    function lockPOT(address bscRecipient) external payable returns (uint64) {
        if (msg.value % NATIVE_UNIT != 0) revert Dust();
        uint256 fee = msg.value * FEE_BPS / 10_000;
        fee -= fee % NATIVE_UNIT;
        uint256 amount = msg.value - fee;
        lockedPOT += amount;
        return _commit(Transfers.POT_TO_BSC, bscRecipient, amount);
    }

    function burnBNBb(uint256 amount, address bscRecipient) external returns (uint64) {
        bnbAsset.safeTransferFrom(msg.sender, address(this), amount);
        return _commit(Transfers.BNBB_TO_BSC, bscRecipient, amount);
    }

    function finalize(Transfer calldata t, bytes calldata proof) external override {
        if (t.kind == Transfers.PPOT_TO_PORTALDOT) {
            _accept(t, proof);
            uint256 locked = lockedPOT;
            if (t.amount > locked) revert ExceedsLocked();
            lockedPOT = locked - t.amount;
            _sendNative(t.recipient, t.amount);
        } else if (t.kind == Transfers.BNB_TO_PORTALDOT) {
            _accept(t, proof);
            // BNB.b is a non-sufficient asset: it can only be credited to an account that already
            // exists, so the drop has to land before the asset does.
            _dropGas(t.recipient, t.amount);
            bnbAsset.safeTransfer(t.recipient, t.amount);
        } else {
            revert WrongKind(t.kind);
        }
    }

    function donateGas() external payable {}

    function gasPool() public view returns (uint256) {
        return address(this).balance - lockedPOT;
    }

    /// @dev Best effort, never reverts: only plain accounts with no balance, only from the pool.
    function _dropGas(address to, uint256 amount) private {
        if (amount < GAS_DROP_MIN_AMOUNT || to.balance != 0 || to.code.length != 0) return;
        if (gasPool() < GAS_DROP) return;
        (bool ok,) = to.call{value: GAS_DROP}("");
        if (ok) emit GasDropped(to, GAS_DROP);
    }
}
