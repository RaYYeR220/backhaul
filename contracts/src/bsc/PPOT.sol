// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title pPOT
/// @notice Portaldot's tPOT on BSC, 18 decimals, 1:1 with tPOT escrowed by the Portaldot gateway.
/// Only the BSC gateway (fixed at deploy) can mint or burn.
contract PPOT is ERC20 {
    address public immutable gateway;

    error NotGateway();
    error ZeroAddress();

    constructor(address gateway_) ERC20("Bridged Portaldot", "pPOT") {
        if (gateway_ == address(0)) revert ZeroAddress();
        gateway = gateway_;
    }

    modifier onlyGateway() {
        if (msg.sender != gateway) revert NotGateway();
        _;
    }

    function mint(address to, uint256 amount) external onlyGateway {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyGateway {
        _burn(from, amount);
    }
}
