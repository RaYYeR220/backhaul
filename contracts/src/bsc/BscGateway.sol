// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {GatewayBase} from "../core/GatewayBase.sol";
import {Outbox} from "../core/Outbox.sol";
import {Transfer, Transfers} from "../core/Transfer.sol";
import {IRemoteVerifier} from "../interfaces/IRemoteVerifier.sol";
import {PPOT} from "./PPOT.sol";

/// @title BscGateway
/// @notice Canonical bridge, BSC side.
/// - tPOT -> BSC: `finalize` kind 1 mints pPOT.
/// - pPOT -> Portaldot: `burnPPOT` burns pPOT; Portaldot releases tPOT.
/// - tBNB -> Portaldot: `lockBNB` escrows tBNB; Portaldot releases BNB.b.
/// - BNB.b -> BSC: `finalize` kind 4 releases escrowed tBNB.
contract BscGateway is GatewayBase {
    /// native tPOT has 14 decimals: pPOT amounts below 1e4 can't be paid out on Portaldot
    uint256 internal constant POT_UNIT = 1e4;

    PPOT public immutable ppot;

    error Dust();
    error PpotNotBound();

    constructor(Outbox outbox_, IRemoteVerifier verifier_, PPOT ppot_) GatewayBase(outbox_, verifier_) {
        if (ppot_.gateway() != address(this)) revert PpotNotBound();
        ppot = ppot_;
    }

    function lockBNB(address recipient) external payable returns (uint64) {
        return _commit(Transfers.BNB_TO_PORTALDOT, recipient, msg.value);
    }

    function burnPPOT(uint256 amount, address recipient) external returns (uint64) {
        if (amount % POT_UNIT != 0) revert Dust();
        ppot.burn(msg.sender, amount);
        return _commit(Transfers.PPOT_TO_PORTALDOT, recipient, amount);
    }

    function finalize(Transfer calldata t, bytes calldata proof) external override {
        if (t.kind == Transfers.POT_TO_BSC) {
            _accept(t, proof);
            ppot.mint(t.recipient, t.amount);
        } else if (t.kind == Transfers.BNBB_TO_BSC) {
            _accept(t, proof);
            _sendNative(t.recipient, t.amount);
        } else {
            revert WrongKind(t.kind);
        }
    }
}
