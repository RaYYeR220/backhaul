// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice A canonical-bridge message. Committed as keccak256(abi.encode(t)) under appKey = nonce.
struct Transfer {
    uint64 nonce;
    uint8 kind;
    address recipient;
    uint256 amount;
}

library Transfers {
    uint8 internal constant POT_TO_BSC = 1; // tPOT locked on Portaldot -> pPOT minted on BSC
    uint8 internal constant PPOT_TO_PORTALDOT = 2; // pPOT burned on BSC -> tPOT released on Portaldot
    uint8 internal constant BNB_TO_PORTALDOT = 3; // tBNB locked on BSC -> BNB.b released on Portaldot
    uint8 internal constant BNBB_TO_BSC = 4; // BNB.b returned on Portaldot -> tBNB released on BSC

    function hash(Transfer memory t) internal pure returns (bytes32) {
        return keccak256(abi.encode(t));
    }

    function appKey(uint64 nonce) internal pure returns (bytes32) {
        return bytes32(uint256(nonce));
    }
}
