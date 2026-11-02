// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PortaldotGateway} from "../portaldot/PortaldotGateway.sol";
import {BscGateway} from "../bsc/BscGateway.sol";

/// @notice The solver-repayment address of an LPVault, living on the vault's origin chain.
/// OriginSettler pays escrow here; `flush` (anyone) sends it all to the vault on the other chain
/// over the canonical bridge. No owner, no other exit.
abstract contract RepayForwarder {
    using SafeERC20 for IERC20;

    /// native tPOT has 14 decimals: tPOT and pPOT amounts move in steps of 1e4 wei-units
    uint256 internal constant POT_UNIT = 1e4;

    address public immutable gateway;
    address public immutable token; // address(0) = native
    address public immutable vault;

    event Flushed(uint256 amount);

    error UnsupportedToken();
    error ZeroAddress();
    error NativeNotAccepted();

    constructor(address gateway_, address token_, address vault_) {
        if (vault_ == address(0)) revert ZeroAddress();
        gateway = gateway_;
        token = token_;
        vault = vault_;
    }

    receive() external payable {
        if (token != address(0)) revert NativeNotAccepted();
    }

    function flush() external returns (uint256 amount) {
        amount = token == address(0) ? address(this).balance : IERC20(token).balanceOf(address(this));
        amount -= amount % _unit();
        if (amount == 0) return 0;
        if (token != address(0) && IERC20(token).allowance(address(this), gateway) < amount) {
            IERC20(token).forceApprove(gateway, type(uint256).max);
        }
        _bridge(amount);
        emit Flushed(amount);
    }

    function _unit() internal view virtual returns (uint256);
    function _bridge(uint256 amount) internal virtual;
}

/// @notice On Portaldot: tPOT -> lockPOT, BNB.b -> burnBNBb.
contract PortaldotRepayForwarder is RepayForwarder {
    constructor(PortaldotGateway gw, address token_, address vault_) RepayForwarder(address(gw), token_, vault_) {
        if (token_ != address(0) && token_ != address(gw.bnbAsset())) revert UnsupportedToken();
    }

    function _unit() internal view override returns (uint256) {
        return token == address(0) ? POT_UNIT : 1;
    }

    function _bridge(uint256 amount) internal override {
        PortaldotGateway gw = PortaldotGateway(gateway);
        if (token == address(0)) gw.lockPOT{value: amount}(vault);
        else gw.burnBNBb(amount, vault);
    }
}

/// @notice On BSC: tBNB -> lockBNB, pPOT -> burnPPOT.
contract BscRepayForwarder is RepayForwarder {
    constructor(BscGateway gw, address token_, address vault_) RepayForwarder(address(gw), token_, vault_) {
        if (token_ != address(0) && token_ != address(gw.ppot())) revert UnsupportedToken();
    }

    function _unit() internal view override returns (uint256) {
        return token == address(0) ? 1 : POT_UNIT;
    }

    function _bridge(uint256 amount) internal override {
        BscGateway gw = BscGateway(gateway);
        if (token == address(0)) gw.lockBNB{value: amount}(vault);
        else gw.burnPPOT(amount, vault);
    }
}
