// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {
    OnchainCrossChainOrder,
    GaslessCrossChainOrder,
    ResolvedCrossChainOrder,
    Output,
    FillInstruction
} from "./ERC7683.sol";
import {BackhaulOrder, BackhaulOrders} from "./BackhaulOrder.sol";
import {Outbox, outboxKey} from "../core/Outbox.sol";
import {IRemoteVerifier} from "../interfaces/IRemoteVerifier.sol";

/// @title OriginSettler
/// @notice ERC-7683 origin settler. Escrows the input on `open` and commits the order to the local
/// Outbox (commitments[keyFor(this, orderId)] = keccak256(originData)), which is what LP vaults on
/// the other chain prove before they fill. Pays the escrow to the solver's `repayTo` once the
/// destination chain's fill is proven, or back to the user once its absence after the deadline is
/// proven. Each order ends exactly once: Open -> Settled | Refunded.
/// @dev Same selectors and Open event as IOriginSettler. It doesn't inherit the interface only
///      because `open` must be payable for native inputs, and Solidity won't let a payable
///      function override a non-payable one.
contract OriginSettler {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Open,
        Settled,
        Refunded
    }

    IRemoteVerifier public immutable verifier;
    Outbox public immutable outbox;
    address private immutable _deployer;

    /// the DestinationSettler on the other chain
    address public remoteDestination;
    mapping(bytes32 => Status) public statusOf;

    event Open(bytes32 indexed orderId, ResolvedCrossChainOrder resolvedOrder);
    event Settled(bytes32 indexed orderId, address repayTo);
    event Refunded(bytes32 indexed orderId, address user);
    event RemoteDestinationSet(address remoteDestination);

    error GaslessNotSupported();
    error WrongOrderDataType();
    error InvalidOrder();
    error DeadlinePassed();
    error NotUser();
    error OrderExists();
    error WrongValue();
    error InputMismatch();
    error NotOpen();
    error NotExpired();
    error InvalidProof();
    error NativeTransferFailed();
    error NotDeployer();
    error RemoteAlreadySet();
    error NotWired();
    error ZeroAddress();

    constructor(IRemoteVerifier verifier_, Outbox outbox_) {
        verifier = verifier_;
        outbox = outbox_;
        _deployer = msg.sender;
    }

    /// @notice One-time wiring to the destination settler. Locked forever once set.
    function setRemoteDestination(address remote) external {
        if (msg.sender != _deployer) revert NotDeployer();
        if (remote == address(0)) revert ZeroAddress();
        if (remoteDestination != address(0)) revert RemoteAlreadySet();
        remoteDestination = remote;
        emit RemoteDestinationSet(remote);
    }

    function open(OnchainCrossChainOrder calldata order) external payable {
        (ResolvedCrossChainOrder memory r, BackhaulOrder memory o) = _resolve(order);
        if (o.user != msg.sender) revert NotUser();
        if (statusOf[r.orderId] != Status.None) revert OrderExists();
        statusOf[r.orderId] = Status.Open;
        // orderId is keccak256(originData), so this commits keccak256(originData)
        outbox.commit(r.orderId, r.orderId);

        if (o.inputToken == address(0)) {
            if (msg.value != o.inputAmount) revert WrongValue();
        } else {
            if (msg.value != 0) revert WrongValue();
            IERC20 token = IERC20(o.inputToken);
            uint256 before = token.balanceOf(address(this));
            token.safeTransferFrom(msg.sender, address(this), o.inputAmount);
            // the escrow must hold exactly what settle/refund pay out
            if (token.balanceOf(address(this)) - before != o.inputAmount) revert InputMismatch();
        }
        emit Open(r.orderId, r);
    }

    function resolve(OnchainCrossChainOrder calldata order) external view returns (ResolvedCrossChainOrder memory r) {
        (r,) = _resolve(order);
    }

    function openFor(GaslessCrossChainOrder calldata, bytes calldata, bytes calldata) external pure {
        revert GaslessNotSupported();
    }

    function resolveFor(GaslessCrossChainOrder calldata, bytes calldata)
        external
        pure
        returns (ResolvedCrossChainOrder memory)
    {
        revert GaslessNotSupported();
    }

    /// @notice Pays the escrow to `repayTo` once the destination Outbox is proven to hold
    ///         keccak256(abi.encode(repayTo)) under this order. Anyone may call.
    function settle(bytes calldata originData, address repayTo, bytes calldata proof) external {
        (bytes32 orderId, BackhaulOrder memory o,,) = BackhaulOrders.decode(originData);
        if (statusOf[orderId] != Status.Open) revert NotOpen();
        if (!verifier.verifyCommitment(_fillKey(orderId), BackhaulOrders.repayCommitment(repayTo), proof)) {
            revert InvalidProof();
        }
        statusOf[orderId] = Status.Settled;
        _pay(o.inputToken, repayTo, o.inputAmount);
        emit Settled(orderId, repayTo);
    }

    /// @notice Returns the escrow to the user once the destination is proven to hold no fill at a
    ///         finalized time after the deadline (fills after the deadline are rejected there).
    function refund(bytes calldata originData, bytes calldata proof) external {
        (bytes32 orderId, BackhaulOrder memory o,, uint32 fillDeadline) = BackhaulOrders.decode(originData);
        if (statusOf[orderId] != Status.Open) revert NotOpen();
        if (block.timestamp <= fillDeadline) revert NotExpired();
        if (!verifier.verifyAbsence(_fillKey(orderId), uint64(fillDeadline) + 1, proof)) revert InvalidProof();
        statusOf[orderId] = Status.Refunded;
        _pay(o.inputToken, o.user, o.inputAmount);
        emit Refunded(orderId, o.user);
    }

    function _fillKey(bytes32 orderId) private view returns (bytes32) {
        address dst = remoteDestination;
        if (dst == address(0)) revert NotWired();
        return outboxKey(dst, orderId);
    }

    function _resolve(OnchainCrossChainOrder calldata order)
        private
        view
        returns (ResolvedCrossChainOrder memory r, BackhaulOrder memory o)
    {
        if (order.orderDataType != BackhaulOrders.ORDER_DATA_TYPE) revert WrongOrderDataType();
        address dst = remoteDestination;
        if (dst == address(0)) revert NotWired();
        if (order.fillDeadline <= block.timestamp) revert DeadlinePassed();
        o = abi.decode(order.orderData, (BackhaulOrder));
        if (o.inputAmount == 0 || o.outputAmount == 0 || o.recipient == address(0)) revert InvalidOrder();

        // forge-lint: disable-next-line(unsafe-typecast)
        bytes memory originData = abi.encode(o, uint64(block.chainid), order.fillDeadline);
        r.user = o.user;
        r.originChainId = block.chainid;
        r.openDeadline = type(uint32).max;
        r.fillDeadline = order.fillDeadline;
        r.orderId = keccak256(originData);
        r.maxSpent = new Output[](1);
        r.maxSpent[0] = Output(_b32(o.outputToken), o.outputAmount, _b32(o.recipient), o.destinationChainId);
        r.minReceived = new Output[](1);
        // the solver isn't known until the fill
        r.minReceived[0] = Output(_b32(o.inputToken), o.inputAmount, bytes32(0), block.chainid);
        r.fillInstructions = new FillInstruction[](1);
        r.fillInstructions[0] = FillInstruction(o.destinationChainId, _b32(dst), originData);
    }

    function _pay(address token, address to, uint256 amount) private {
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    function _b32(address a) private pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }
}
