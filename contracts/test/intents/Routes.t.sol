// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BridgeFixture} from "../core/BridgeFixture.sol";
import {Transfer, Transfers} from "../../src/core/Transfer.sol";
import {OnchainCrossChainOrder} from "../../src/intents/ERC7683.sol";
import {BackhaulOrder, BackhaulOrders} from "../../src/intents/BackhaulOrder.sol";
import {OriginSettler} from "../../src/intents/OriginSettler.sol";
import {DestinationSettler} from "../../src/intents/DestinationSettler.sol";
import {LPVault} from "../../src/intents/LPVault.sol";
import {RepayForwarder, PortaldotRepayForwarder, BscRepayForwarder} from "../../src/intents/RepayForwarder.sol";

/// All four fast routes end to end on the real gateways: the user is paid by a vault on the
/// destination, the solver repayment is proven on the origin, and it comes home to the vault
/// through the canonical bridge. Fees end up in the vault's share price.
contract RoutesTest is BridgeFixture {
    uint64 internal constant PORTALDOT = 420420777;
    uint64 internal constant BSC = 97;
    uint16 internal constant MIN_FEE = 30;

    // Portaldot side
    OriginSettler internal originP;
    DestinationSettler internal destP;
    LPVault internal potVault; // native tPOT, fills pPOT -> tPOT
    LPVault internal bnbbVault; // BNB.b, fills tBNB -> BNB.b
    PortaldotRepayForwarder internal potFwd; // repays ppotVault
    PortaldotRepayForwarder internal bnbbFwd; // repays bnbVault

    // BSC side
    OriginSettler internal originB;
    DestinationSettler internal destB;
    LPVault internal ppotVault; // pPOT, fills tPOT -> pPOT
    LPVault internal bnbVault; // native tBNB, fills BNB.b -> tBNB
    BscRepayForwarder internal ppotFwd; // repays potVault
    BscRepayForwarder internal bnbFwd; // repays bnbbVault

    address internal operator = makeAddr("operator");
    address internal lp = makeAddr("lp");
    address internal user = makeAddr("user");
    address internal recipient = makeAddr("recipient");

    function setUp() public override {
        super.setUp();
        originP = new OriginSettler(verP);
        originB = new OriginSettler(verB);
        destP = new DestinationSettler(outboxP, PORTALDOT);
        destB = new DestinationSettler(outboxB, BSC);
        originP.setRemoteDestination(address(destB));
        originB.setRemoteDestination(address(destP));

        potVault = new LPVault(address(0), destP, operator, MIN_FEE);
        bnbbVault = new LPVault(BNBB, destP, operator, MIN_FEE);
        ppotVault = new LPVault(address(ppot), destB, operator, MIN_FEE);
        bnbVault = new LPVault(address(0), destB, operator, MIN_FEE);

        potFwd = new PortaldotRepayForwarder(pGw, address(0), address(ppotVault));
        bnbbFwd = new PortaldotRepayForwarder(pGw, BNBB, address(bnbVault));
        ppotFwd = new BscRepayForwarder(bGw, address(ppot), address(potVault));
        bnbFwd = new BscRepayForwarder(bGw, address(0), address(bnbbVault));

        ppotVault.setRemote(address(potFwd), address(0), PORTALDOT);
        bnbVault.setRemote(address(bnbbFwd), BNBB, PORTALDOT);
        potVault.setRemote(address(ppotFwd), address(ppot), BSC);
        bnbbVault.setRemote(address(bnbFwd), address(0), BSC);

        // the LP and the user get bridged assets the slow way first
        bGw.finalize(_lockPOT(lp, 1_000e18, lp), "");
        bGw.finalize(_lockPOT(user, 100e18, user), "");
        vm.deal(lp, 1_000e18);
        vm.deal(user, 100e18);
        pGw.finalize(_lockBNB(lp, 100e18, lp), "");
        pGw.finalize(_lockBNB(user, 10e18, user), "");
    }

    function _open(OriginSettler origin, uint64 originChain, BackhaulOrder memory o)
        internal
        returns (bytes32 orderId, bytes memory originData)
    {
        uint32 deadline = uint32(block.timestamp + 600);
        originData = abi.encode(o, originChain, deadline);
        orderId = keccak256(originData);
        vm.chainId(originChain);
        vm.startPrank(o.user);
        if (o.inputToken == address(ppot)) ppot.approve(address(origin), o.inputAmount);
        if (o.inputToken == BNBB) bnbb.approve(address(origin), o.inputAmount);
        origin.open{value: o.inputToken == address(0) ? o.inputAmount : 0}(
            OnchainCrossChainOrder(deadline, BackhaulOrders.ORDER_DATA_TYPE, abi.encode(o))
        );
        vm.stopPrank();
    }

    function _depositNative(LPVault v, uint256 amount) internal {
        vm.prank(lp);
        v.deposit{value: amount}(amount);
    }

    function _depositToken(LPVault v, address token, uint256 amount) internal {
        vm.startPrank(lp);
        if (token == address(ppot)) ppot.approve(address(v), amount);
        else bnbb.approve(address(v), amount);
        v.deposit(amount);
        vm.stopPrank();
    }

    /// tPOT on Portaldot -> pPOT on BSC, filled by the pPOT vault, repaid via lockPOT.
    function test_routePotToPpot() public {
        _depositToken(ppotVault, address(ppot), 500e18);
        BackhaulOrder memory o = BackhaulOrder(user, address(0), 10e18, address(ppot), 9.96e18, recipient, BSC, 1);
        (bytes32 id, bytes memory d) = _open(originP, PORTALDOT, o);

        vm.prank(operator);
        ppotVault.fill(id, d);
        assertEq(ppot.balanceOf(recipient), 9.96e18);

        originP.settle(d, address(potFwd), ""); // proves the fill on BSC
        assertEq(address(potFwd).balance, 10e18);

        uint64 nonce = pGw.nextNonce();
        potFwd.flush();
        Transfer memory t = Transfer(nonce, Transfers.POT_TO_BSC, address(ppotVault), 10e18 - 1e16);
        bGw.finalize(t, "");
        ppotVault.notifyRepaid();

        assertEq(ppotVault.pendingRepay(), 0);
        assertEq(ppotVault.totalAssets(), 500e18 + 0.03e18); // 0.4% spread minus the 0.1% bridge fee
    }

    /// pPOT on BSC -> tPOT on Portaldot, filled by the tPOT vault, repaid via burnPPOT.
    function test_routePpotToPot() public {
        _depositNative(potVault, 100e18);
        BackhaulOrder memory o = BackhaulOrder(user, address(ppot), 10e18, address(0), 9.96e18, recipient, PORTALDOT, 1);
        (bytes32 id, bytes memory d) = _open(originB, BSC, o);

        vm.prank(operator);
        potVault.fill(id, d);
        assertEq(recipient.balance, 9.96e18);

        originB.settle(d, address(ppotFwd), "");
        uint64 nonce = bGw.nextNonce();
        ppotFwd.flush();
        pGw.finalize(Transfer(nonce, Transfers.PPOT_TO_PORTALDOT, address(potVault), 10e18), "");

        assertEq(potVault.pendingRepay(), 0); // synced on receive
        assertEq(potVault.totalAssets(), 100.04e18);
    }

    /// tBNB on BSC -> BNB.b on Portaldot, filled by the BNB.b vault, repaid via lockBNB.
    function test_routeBnbToBnbb() public {
        _depositToken(bnbbVault, BNBB, 50e18);
        BackhaulOrder memory o = BackhaulOrder(user, address(0), 1e18, BNBB, 0.996e18, recipient, PORTALDOT, 1);
        (bytes32 id, bytes memory d) = _open(originB, BSC, o);

        vm.prank(operator);
        bnbbVault.fill(id, d);
        assertEq(bnbb.balanceOf(recipient), 0.996e18);

        originB.settle(d, address(bnbFwd), "");
        uint64 nonce = bGw.nextNonce();
        bnbFwd.flush();
        pGw.finalize(Transfer(nonce, Transfers.BNB_TO_PORTALDOT, address(bnbbVault), 1e18), "");
        bnbbVault.notifyRepaid();

        assertEq(bnbbVault.pendingRepay(), 0);
        assertEq(bnbbVault.totalAssets(), 50.004e18);
    }

    /// BNB.b on Portaldot -> tBNB on BSC, filled by the tBNB vault, repaid via burnBNBb.
    function test_routeBnbbToBnb() public {
        _depositNative(bnbVault, 50e18);
        BackhaulOrder memory o = BackhaulOrder(user, BNBB, 1e18, address(0), 0.996e18, recipient, BSC, 1);
        (bytes32 id, bytes memory d) = _open(originP, PORTALDOT, o);

        vm.prank(operator);
        bnbVault.fill(id, d);
        assertEq(recipient.balance, 0.996e18);

        originP.settle(d, address(bnbbFwd), "");
        uint64 nonce = pGw.nextNonce();
        bnbbFwd.flush();
        bGw.finalize(Transfer(nonce, Transfers.BNBB_TO_BSC, address(bnbVault), 1e18), "");

        assertEq(bnbVault.pendingRepay(), 0);
        assertEq(bnbVault.totalAssets(), 50.004e18);
    }

    function test_forwarderRoundsToPotUnitAndKeepsDust() public {
        vm.deal(address(potFwd), 1e18 + 123);
        uint256 sent = potFwd.flush();
        assertEq(sent, 1e18);
        assertEq(address(potFwd).balance, 123);
        assertEq(potFwd.flush(), 0); // nothing left that can be sent
    }

    function test_forwarderRejectsForeignToken() public {
        vm.expectRevert(RepayForwarder.UnsupportedToken.selector);
        new PortaldotRepayForwarder(pGw, address(ppot), address(ppotVault));
        vm.expectRevert(RepayForwarder.UnsupportedToken.selector);
        new BscRepayForwarder(bGw, BNBB, address(potVault));
    }
}
