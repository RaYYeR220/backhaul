// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Plain ERC-20 standing in for the pallet-assets ERC-20 precompile (BNB.b).
/// Tests deploy it once and `vm.etch` its code at the precompile address, so nothing may
/// depend on constructor-set storage: metadata is constant.
/// `nonSufficient` models a non-sufficient pallet-assets asset: it cannot be credited to an
/// account that does not exist yet (no native balance and no asset balance) - `CannotCreate`.
contract MockAssetPrecompile {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;
    bool public nonSufficient;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error CannotCreate();
    error InsufficientBalance();
    error InsufficientAllowance();

    function name() external pure returns (string memory) {
        return "Bridged BNB";
    }

    function symbol() external pure returns (string memory) {
        return "BNB.b";
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }

    /// test helper
    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    /// test helper
    function setNonSufficient(bool on) external {
        nonSufficient = on;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            if (a < amount) revert InsufficientAllowance();
            allowance[from][msg.sender] = a - amount;
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        if (balanceOf[from] < amount) revert InsufficientBalance();
        if (nonSufficient && balanceOf[to] == 0 && to.balance == 0) revert CannotCreate();
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
