// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Outbox, outboxKey} from "../core/Outbox.sol";
import {BackhaulOrder, BackhaulOrders} from "./BackhaulOrder.sol";

/// @title DestinationSettler
/// @notice ERC-7683 destination settler. A solver pays the order's recipient from its own funds,
/// and the fill is recorded in this chain's Outbox as commitments[keyFor(this, orderId)] =
/// keccak256(abi.encode(repayTo)). The origin chain proves that commitment to repay the solver,
/// or proves its absence after the deadline to refund the user.
/// @dev Same `fill` selector as IDestinationSettler; payable for native outputs (see OriginSettler).
///      Holds no state of its own: the Outbox commitment is the fill record.
contract DestinationSettler {
    using SafeERC20 for IERC20;

    Outbox public immutable outbox;
    uint64 public immutable chainId;

    event Filled(bytes32 orderId, address filler, address repayTo);

    error BadOrderId();
    error WrongChain();
    error FillDeadlinePassed();
    error AlreadyFilled();
    error ZeroAddress();
    error WrongValue();
    error NativeTransferFailed();

    constructor(Outbox outbox_, uint64 chainId_) {
        outbox = outbox_;
        chainId = chainId_;
    }

    /// @param fillerData abi.encode(address repayTo): who gets the escrow on the origin chain
    function fill(bytes32 orderId, bytes calldata originData, bytes calldata fillerData) external payable {
        (bytes32 id, BackhaulOrder memory o,, uint32 fillDeadline) = BackhaulOrders.decode(originData);
        if (id != orderId) revert BadOrderId();
        if (o.destinationChainId != chainId) revert WrongChain();
        if (block.timestamp > fillDeadline) revert FillDeadlinePassed();
        address repayTo = abi.decode(fillerData, (address));
        if (repayTo == address(0)) revert ZeroAddress();
        if (filled(orderId)) revert AlreadyFilled();

        // record first: a re-entrant fill of the same order hits AlreadyFilled
        outbox.commit(orderId, BackhaulOrders.repayCommitment(repayTo));

        if (o.outputToken == address(0)) {
            if (msg.value != o.outputAmount) revert WrongValue();
            (bool ok,) = o.recipient.call{value: msg.value}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            if (msg.value != 0) revert WrongValue();
            IERC20(o.outputToken).safeTransferFrom(msg.sender, o.recipient, o.outputAmount);
        }
        emit Filled(orderId, msg.sender, repayTo);
    }

    function filled(bytes32 orderId) public view returns (bool) {
        return outbox.commitments(outboxKey(address(this), orderId)) != bytes32(0);
    }
}
