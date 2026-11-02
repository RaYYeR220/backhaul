// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Backhaul's ERC-7683 order data. `address(0)` as a token means the chain's native coin.
struct BackhaulOrder {
    address user;
    address inputToken;
    uint256 inputAmount;
    address outputToken;
    uint256 outputAmount;
    address recipient;
    uint64 destinationChainId;
    uint64 nonce;
}

/// @notice originData = abi.encode(order, uint64 originChainId, uint32 fillDeadline); orderId = keccak256(originData).
/// A fill commits keccak256(abi.encode(repayTo)) under the orderId in the destination Outbox.
library BackhaulOrders {
    bytes32 internal constant ORDER_DATA_TYPE = keccak256(
        "BackhaulOrder(address user,address inputToken,uint256 inputAmount,address outputToken,uint256 outputAmount,address recipient,uint64 destinationChainId,uint64 nonce)"
    );

    /// @dev The id is taken over the re-encoded fields, so trailing bytes can't mint a second id
    ///      for the same order.
    function decode(bytes calldata originData)
        internal
        pure
        returns (bytes32 orderId, BackhaulOrder memory order, uint64 originChainId, uint32 fillDeadline)
    {
        (order, originChainId, fillDeadline) = abi.decode(originData, (BackhaulOrder, uint64, uint32));
        orderId = keccak256(abi.encode(order, originChainId, fillDeadline));
    }

    function repayCommitment(address repayTo) internal pure returns (bytes32) {
        return keccak256(abi.encode(repayTo));
    }
}
