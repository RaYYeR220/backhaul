// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {Outbox, outboxKey} from "../../src/core/Outbox.sol";
import {
    OnchainCrossChainOrder,
    GaslessCrossChainOrder,
    ResolvedCrossChainOrder,
    IOriginSettler,
    IDestinationSettler
} from "../../src/intents/ERC7683.sol";
import {BackhaulOrder, BackhaulOrders} from "../../src/intents/BackhaulOrder.sol";
import {OriginSettler} from "../../src/intents/OriginSettler.sol";
import {DestinationSettler} from "../../src/intents/DestinationSettler.sol";
import {MockRemoteVerifier} from "../mocks/MockRemoteVerifier.sol";
import {MockERC20, FeeOnTransferERC20} from "../mocks/MockERC20.sol";

/// Native recipient that tries to fill the same order again while being paid.
contract ReenteringRecipient {
    DestinationSettler internal dest;
    bytes32 internal id;
    bytes internal data;
    bool public blocked;

    function arm(DestinationSettler d, bytes32 i, bytes calldata dd) external {
        dest = d;
        id = i;
        data = dd;
    }

    receive() external payable {
        DestinationSettler d = dest;
        if (address(d) == address(0)) return;
        dest = DestinationSettler(address(0));
        try d.fill{value: msg.value}(id, data, abi.encode(address(this))) {}
        catch {
            blocked = true;
        }
    }
}

/// Native repayTo that tries to settle or refund the same order again while being paid.
contract ReenteringRepay {
    OriginSettler internal origin;
    bytes internal data;
    bool public tried;
    bool public blocked;

    function arm(OriginSettler o, bytes calldata d) external {
        origin = o;
        data = d;
    }

    receive() external payable {
        OriginSettler o = origin;
        if (address(o) == address(0)) return;
        origin = OriginSettler(address(0));
        tried = true;
        bool any;
        try o.settle(data, address(this), "") {
            any = true;
        } catch {}
        try o.refund(data, "") {
            any = true;
        } catch {}
        blocked = !any;
    }
}

/// Origin on "Portaldot", destination on "BSC", both in one EVM. The origin's verifier mirrors
/// the destination Outbox, so it accepts exactly what the light client would prove.
contract SettlersTest is Test {
    uint64 internal constant PORTALDOT = 420420777;
    uint64 internal constant BSC = 97;

    Outbox internal outboxP;
    Outbox internal outboxB;
    MockRemoteVerifier internal verP;
    OriginSettler internal origin;
    DestinationSettler internal dest;
    MockERC20 internal tokenIn;
    MockERC20 internal tokenOut;

    address internal user = makeAddr("user");
    address internal recipient = makeAddr("recipient");
    address internal solver = makeAddr("solver");
    address internal repay = makeAddr("repay");
    uint32 internal deadline;

    function setUp() public {
        vm.chainId(PORTALDOT);
        vm.warp(1_800_000_000);
        deadline = uint32(block.timestamp + 600);

        outboxP = new Outbox();
        outboxB = new Outbox();
        verP = new MockRemoteVerifier();
        verP.setMirror(address(outboxB));
        origin = new OriginSettler(verP, outboxP);
        dest = new DestinationSettler(outboxB, BSC);
        origin.setRemoteDestination(address(dest));

        tokenIn = new MockERC20("In", "IN");
        tokenOut = new MockERC20("Out", "OUT");
        tokenIn.mint(user, 1_000e18);
        tokenOut.mint(solver, 1_000e18);
        vm.prank(user);
        tokenIn.approve(address(origin), type(uint256).max);
        vm.prank(solver);
        tokenOut.approve(address(dest), type(uint256).max);
    }

    // ---------------------------------------------------------------- helpers

    function _order(address inTok, uint256 inAmt, address outTok, uint256 outAmt, uint64 nonce)
        internal
        view
        returns (BackhaulOrder memory)
    {
        return BackhaulOrder(user, inTok, inAmt, outTok, outAmt, recipient, BSC, nonce);
    }

    function _onchain(BackhaulOrder memory o, uint32 fd) internal pure returns (OnchainCrossChainOrder memory) {
        return OnchainCrossChainOrder(fd, BackhaulOrders.ORDER_DATA_TYPE, abi.encode(o));
    }

    function _open(BackhaulOrder memory o) internal returns (bytes32 orderId, bytes memory originData) {
        originData = abi.encode(o, PORTALDOT, deadline);
        orderId = keccak256(originData);
        vm.prank(o.user);
        origin.open{value: o.inputToken == address(0) ? o.inputAmount : 0}(_onchain(o, deadline));
    }

    function _defaultOrder() internal view returns (BackhaulOrder memory) {
        return _order(address(tokenIn), 10e18, address(tokenOut), 9.97e18, 1);
    }

    function _fill(bytes32 orderId, bytes memory originData, address repayTo, uint256 value) internal {
        vm.deal(solver, solver.balance + value);
        vm.prank(solver);
        dest.fill{value: value}(orderId, originData, abi.encode(repayTo));
    }

    // ---------------------------------------------------------------- happy path

    function test_openFillSettle() public {
        BackhaulOrder memory o = _defaultOrder();
        (bytes32 orderId, bytes memory originData) = _open(o);
        assertEq(uint8(origin.statusOf(orderId)), 1);
        // the Open fact other chains prove before an LP vault fills
        assertEq(outboxP.commitments(outboxKey(address(origin), orderId)), keccak256(originData));
        assertEq(tokenIn.balanceOf(address(origin)), 10e18);

        vm.expectEmit(address(dest));
        emit DestinationSettler.Filled(orderId, solver, repay);
        _fill(orderId, originData, repay, 0);
        assertEq(tokenOut.balanceOf(recipient), 9.97e18);
        assertTrue(dest.filled(orderId));
        assertEq(outboxB.commitments(outboxKey(address(dest), orderId)), keccak256(abi.encode(repay)));

        vm.expectEmit(address(origin));
        emit OriginSettler.Settled(orderId, repay);
        origin.settle(originData, repay, "");
        assertEq(tokenIn.balanceOf(repay), 10e18);
        assertEq(tokenIn.balanceOf(address(origin)), 0);
        assertEq(uint8(origin.statusOf(orderId)), 2);
    }

    function test_openFillSettleNative() public {
        BackhaulOrder memory o = _order(address(0), 1e18, address(0), 0.99e18, 7);
        vm.deal(user, 1e18);
        (bytes32 orderId, bytes memory originData) = _open(o);
        assertEq(address(origin).balance, 1e18);

        _fill(orderId, originData, repay, 0.99e18);
        assertEq(recipient.balance, 0.99e18);

        origin.settle(originData, repay, "");
        assertEq(repay.balance, 1e18);
        assertEq(address(origin).balance, 0);
    }

    function test_openEmitsResolvedOrder() public {
        BackhaulOrder memory o = _defaultOrder();
        ResolvedCrossChainOrder memory r = origin.resolve(_onchain(o, deadline));
        bytes memory originData = abi.encode(o, PORTALDOT, deadline);
        assertEq(r.orderId, keccak256(originData));
        assertEq(r.user, user);
        assertEq(r.originChainId, PORTALDOT);
        assertEq(r.fillDeadline, deadline);
        assertEq(r.openDeadline, type(uint32).max);
        assertEq(r.maxSpent.length, 1);
        assertEq(r.maxSpent[0].token, bytes32(uint256(uint160(address(tokenOut)))));
        assertEq(r.maxSpent[0].amount, 9.97e18);
        assertEq(r.maxSpent[0].recipient, bytes32(uint256(uint160(recipient))));
        assertEq(r.maxSpent[0].chainId, BSC);
        assertEq(r.minReceived.length, 1);
        assertEq(r.minReceived[0].token, bytes32(uint256(uint160(address(tokenIn)))));
        assertEq(r.minReceived[0].amount, 10e18);
        assertEq(r.minReceived[0].recipient, bytes32(0));
        assertEq(r.minReceived[0].chainId, PORTALDOT);
        assertEq(r.fillInstructions.length, 1);
        assertEq(r.fillInstructions[0].destinationChainId, BSC);
        assertEq(r.fillInstructions[0].destinationSettler, bytes32(uint256(uint160(address(dest)))));
        assertEq(r.fillInstructions[0].originData, originData);

        vm.expectEmit(address(origin));
        emit IOriginSettler.Open(r.orderId, r);
        _open(o);
    }

    /// Selectors and the Open topic match the ERC even though native value forces `payable`.
    function test_matchesErc7683Abi() public pure {
        assertEq(OriginSettler.open.selector, IOriginSettler.open.selector);
        assertEq(OriginSettler.openFor.selector, IOriginSettler.openFor.selector);
        assertEq(OriginSettler.resolve.selector, IOriginSettler.resolve.selector);
        assertEq(OriginSettler.resolveFor.selector, IOriginSettler.resolveFor.selector);
        assertEq(DestinationSettler.fill.selector, IDestinationSettler.fill.selector);
        assertEq(OriginSettler.Open.selector, IOriginSettler.Open.selector);
    }

    function test_orderDataType() public pure {
        assertEq(
            BackhaulOrders.ORDER_DATA_TYPE,
            keccak256(
                "BackhaulOrder(address user,address inputToken,uint256 inputAmount,address outputToken,uint256 outputAmount,address recipient,uint64 destinationChainId,uint64 nonce)"
            )
        );
    }

    // ---------------------------------------------------------------- replay and settlement

    function test_settleTwiceReverts() public {
        (bytes32 orderId, bytes memory originData) = _open(_defaultOrder());
        _fill(orderId, originData, repay, 0);
        origin.settle(originData, repay, "");
        vm.expectRevert(OriginSettler.NotOpen.selector);
        origin.settle(originData, repay, "");
        vm.expectRevert(OriginSettler.NotOpen.selector);
        origin.refund(originData, "");
    }

    /// A settled order can't be opened again and settled against the same fill.
    function test_reopenAfterSettleReverts() public {
        BackhaulOrder memory o = _defaultOrder();
        (bytes32 orderId, bytes memory originData) = _open(o);
        _fill(orderId, originData, repay, 0);
        origin.settle(originData, repay, "");
        vm.prank(user);
        vm.expectRevert(OriginSettler.OrderExists.selector);
        origin.open(_onchain(o, deadline));
    }

    function test_settleWrongRepayToReverts() public {
        (bytes32 orderId, bytes memory originData) = _open(_defaultOrder());
        _fill(orderId, originData, repay, 0);
        vm.expectRevert(OriginSettler.InvalidProof.selector);
        origin.settle(originData, solver, "");
        origin.settle(originData, repay, "");
        assertEq(tokenIn.balanceOf(repay), 10e18);
        assertEq(tokenIn.balanceOf(solver), 0);
    }

    function test_settleUnfilledReverts() public {
        (, bytes memory originData) = _open(_defaultOrder());
        vm.expectRevert(OriginSettler.InvalidProof.selector);
        origin.settle(originData, repay, "");
    }

    /// A fill for a look-alike order (different nonce) doesn't settle the real one.
    function test_settleWithOtherOrdersFillReverts() public {
        BackhaulOrder memory o = _defaultOrder();
        (, bytes memory originData) = _open(o);
        BackhaulOrder memory twin = _defaultOrder();
        twin.nonce = 2;
        bytes memory twinData = abi.encode(twin, PORTALDOT, deadline);
        _fill(keccak256(twinData), twinData, repay, 0);
        vm.expectRevert(OriginSettler.InvalidProof.selector);
        origin.settle(originData, repay, "");
    }

    function test_settleUnknownOrderReverts() public {
        bytes memory originData = abi.encode(_defaultOrder(), PORTALDOT, deadline);
        _fill(keccak256(originData), originData, repay, 0);
        vm.expectRevert(OriginSettler.NotOpen.selector);
        origin.settle(originData, repay, "");
    }

    /// Trailing bytes after the canonical encoding don't create a second order id.
    function test_paddedOriginDataMapsToCanonicalOrder() public {
        (bytes32 orderId, bytes memory originData) = _open(_defaultOrder());
        bytes memory padded = bytes.concat(originData, bytes32(uint256(1)));
        vm.prank(solver);
        vm.expectRevert(DestinationSettler.BadOrderId.selector);
        dest.fill(keccak256(padded), padded, abi.encode(repay));

        vm.prank(solver);
        dest.fill(orderId, padded, abi.encode(repay));
        assertTrue(dest.filled(orderId));
        origin.settle(padded, repay, "");
        assertEq(tokenIn.balanceOf(repay), 10e18);
    }

    // ---------------------------------------------------------------- fills

    function test_fillAfterDeadlineReverts() public {
        (bytes32 orderId, bytes memory originData) = _open(_defaultOrder());
        vm.warp(uint256(deadline) + 1);
        vm.prank(solver);
        vm.expectRevert(DestinationSettler.FillDeadlinePassed.selector);
        dest.fill(orderId, originData, abi.encode(repay));
    }

    function test_fillAtDeadlineWorks() public {
        (bytes32 orderId, bytes memory originData) = _open(_defaultOrder());
        vm.warp(deadline);
        _fill(orderId, originData, repay, 0);
        assertTrue(dest.filled(orderId));
    }

    function test_fillTwiceReverts() public {
        (bytes32 orderId, bytes memory originData) = _open(_defaultOrder());
        _fill(orderId, originData, repay, 0);
        vm.prank(solver);
        vm.expectRevert(DestinationSettler.AlreadyFilled.selector);
        dest.fill(orderId, originData, abi.encode(solver));
        assertEq(tokenOut.balanceOf(recipient), 9.97e18);
    }

    function test_fillChecks() public {
        BackhaulOrder memory o = _defaultOrder();
        (bytes32 orderId, bytes memory originData) = _open(o);

        vm.startPrank(solver);
        vm.expectRevert(DestinationSettler.BadOrderId.selector);
        dest.fill(bytes32(uint256(orderId) ^ 1), originData, abi.encode(repay));

        vm.expectRevert(DestinationSettler.ZeroAddress.selector);
        dest.fill(orderId, originData, abi.encode(address(0)));

        vm.deal(solver, 1);
        vm.expectRevert(DestinationSettler.WrongValue.selector);
        dest.fill{value: 1}(orderId, originData, abi.encode(repay));
        vm.stopPrank();

        BackhaulOrder memory elsewhere = _defaultOrder();
        elsewhere.destinationChainId = 56;
        bytes memory d = abi.encode(elsewhere, PORTALDOT, deadline);
        vm.prank(solver);
        vm.expectRevert(DestinationSettler.WrongChain.selector);
        dest.fill(keccak256(d), d, abi.encode(repay));
    }

    function test_fillNativeWrongValueReverts() public {
        BackhaulOrder memory o = _order(address(0), 1e18, address(0), 0.99e18, 7);
        vm.deal(user, 1e18);
        (bytes32 orderId, bytes memory originData) = _open(o);
        vm.deal(solver, 1e18);
        vm.prank(solver);
        vm.expectRevert(DestinationSettler.WrongValue.selector);
        dest.fill{value: 0.98e18}(orderId, originData, abi.encode(repay));
    }

    // ---------------------------------------------------------------- refunds

    function test_refundAfterDeadline() public {
        (bytes32 orderId, bytes memory originData) = _open(_defaultOrder());
        vm.warp(uint256(deadline) + 1);
        vm.expectEmit(address(origin));
        emit OriginSettler.Refunded(orderId, user);
        vm.prank(solver); // anyone can trigger it; the money goes to the user
        origin.refund(originData, "");
        assertEq(tokenIn.balanceOf(user), 1_000e18);
        assertEq(uint8(origin.statusOf(orderId)), 3);

        vm.expectRevert(OriginSettler.NotOpen.selector);
        origin.refund(originData, "");
        vm.expectRevert(OriginSettler.NotOpen.selector);
        origin.settle(originData, repay, "");
    }

    function test_refundNativeAfterDeadline() public {
        BackhaulOrder memory o = _order(address(0), 1e18, address(0), 0.99e18, 7);
        vm.deal(user, 1e18);
        (, bytes memory originData) = _open(o);
        vm.warp(uint256(deadline) + 1);
        origin.refund(originData, "");
        assertEq(user.balance, 1e18);
    }

    function test_refundBeforeDeadlineReverts() public {
        (, bytes memory originData) = _open(_defaultOrder());
        vm.warp(deadline);
        vm.expectRevert(OriginSettler.NotExpired.selector);
        origin.refund(originData, "");

        // even with a verifier that would say "absent", the local clock must agree
        verP.setAbsence(keccak256(abi.encode(address(dest), keccak256(originData))), true);
        vm.expectRevert(OriginSettler.NotExpired.selector);
        origin.refund(originData, "");
    }

    function test_refundWhenFilledReverts() public {
        (bytes32 orderId, bytes memory originData) = _open(_defaultOrder());
        _fill(orderId, originData, repay, 0);
        vm.warp(uint256(deadline) + 1);
        vm.expectRevert(OriginSettler.InvalidProof.selector);
        origin.refund(originData, "");
        // the solver is still paid
        origin.settle(originData, repay, "");
        assertEq(tokenIn.balanceOf(repay), 10e18);
    }

    // ---------------------------------------------------------------- open checks

    function test_openChecks() public {
        BackhaulOrder memory o = _defaultOrder();

        vm.prank(solver); // not the order's user
        vm.expectRevert(OriginSettler.NotUser.selector);
        origin.open(_onchain(o, deadline));

        OnchainCrossChainOrder memory wrongType = _onchain(o, deadline);
        wrongType.orderDataType = keccak256("Other()");
        vm.prank(user);
        vm.expectRevert(OriginSettler.WrongOrderDataType.selector);
        origin.open(wrongType);

        vm.prank(user);
        vm.expectRevert(OriginSettler.DeadlinePassed.selector);
        origin.open(_onchain(o, uint32(block.timestamp)));

        vm.deal(user, 1);
        vm.prank(user);
        vm.expectRevert(OriginSettler.WrongValue.selector);
        origin.open{value: 1}(_onchain(o, deadline));

        BackhaulOrder memory zero = _defaultOrder();
        zero.inputAmount = 0;
        vm.prank(user);
        vm.expectRevert(OriginSettler.InvalidOrder.selector);
        origin.open(_onchain(zero, deadline));

        BackhaulOrder memory noRecipient = _defaultOrder();
        noRecipient.recipient = address(0);
        vm.prank(user);
        vm.expectRevert(OriginSettler.InvalidOrder.selector);
        origin.open(_onchain(noRecipient, deadline));

        _open(o);
        vm.prank(user);
        vm.expectRevert(OriginSettler.OrderExists.selector);
        origin.open(_onchain(o, deadline));
    }

    function test_openNativeWrongValueReverts() public {
        BackhaulOrder memory o = _order(address(0), 1e18, address(0), 0.99e18, 7);
        vm.deal(user, 2e18);
        vm.prank(user);
        vm.expectRevert(OriginSettler.WrongValue.selector);
        origin.open{value: 2e18}(_onchain(o, deadline));
    }

    /// The escrow must hold exactly what settle/refund will pay out.
    function test_openRejectsFeeOnTransferToken() public {
        FeeOnTransferERC20 tax = new FeeOnTransferERC20();
        tax.mint(user, 100e18);
        vm.prank(user);
        tax.approve(address(origin), type(uint256).max);
        BackhaulOrder memory o = _order(address(tax), 10e18, address(tokenOut), 9e18, 1);
        vm.prank(user);
        vm.expectRevert(OriginSettler.InputMismatch.selector);
        origin.open(_onchain(o, deadline));
    }

    function test_gaslessNotSupported() public {
        GaslessCrossChainOrder memory g;
        vm.expectRevert(OriginSettler.GaslessNotSupported.selector);
        origin.openFor(g, "", "");
        vm.expectRevert(OriginSettler.GaslessNotSupported.selector);
        origin.resolveFor(g, "");
    }

    function test_setRemoteDestinationOnce() public {
        OriginSettler o = new OriginSettler(verP, outboxP);
        vm.prank(user);
        vm.expectRevert(OriginSettler.NotDeployer.selector);
        o.setRemoteDestination(address(dest));

        vm.prank(user);
        vm.expectRevert(OriginSettler.NotWired.selector);
        o.open(_onchain(_defaultOrder(), deadline));

        vm.expectRevert(OriginSettler.ZeroAddress.selector);
        o.setRemoteDestination(address(0));
        o.setRemoteDestination(address(dest));
        vm.expectRevert(OriginSettler.RemoteAlreadySet.selector);
        o.setRemoteDestination(user);
        assertEq(o.remoteDestination(), address(dest));
    }

    // ---------------------------------------------------------------- reentrancy

    function test_reentrantFillIsBlocked() public {
        ReenteringRecipient r = new ReenteringRecipient();
        BackhaulOrder memory o = BackhaulOrder(user, address(0), 1e18, address(0), 0.99e18, address(r), BSC, 9);
        vm.deal(user, 1e18);
        (bytes32 id, bytes memory d) = _open(o);
        r.arm(dest, id, d);
        _fill(id, d, repay, 0.99e18);
        assertTrue(r.blocked());
        assertEq(address(r).balance, 0.99e18);
        origin.settle(d, repay, "");
        assertEq(repay.balance, 1e18);
    }

    function test_reentrantSettleIsBlocked() public {
        vm.deal(user, 2e18);
        _open(_order(address(0), 1e18, address(0), 0.99e18, 8)); // someone else's escrow
        ReenteringRepay rp = new ReenteringRepay();
        (bytes32 id, bytes memory d) = _open(_order(address(0), 1e18, address(0), 0.99e18, 9));
        _fill(id, d, address(rp), 0.99e18);
        rp.arm(origin, d);
        origin.settle(d, address(rp), "");
        assertTrue(rp.tried());
        assertTrue(rp.blocked());
        assertEq(address(rp).balance, 1e18);
        assertEq(address(origin).balance, 1e18);
    }

    // ---------------------------------------------------------------- fuzz

    /// Whatever happens, each order pays out exactly once: to the solver or back to the user.
    function testFuzz_orderPaysOutOnce(uint96 inAmt, uint96 outAmt, bool doFill, uint32 later) public {
        vm.assume(inAmt > 0 && outAmt > 0 && inAmt <= 1_000e18 && outAmt <= 1_000e18);
        BackhaulOrder memory o = _order(address(tokenIn), inAmt, address(tokenOut), outAmt, 3);
        (bytes32 orderId, bytes memory originData) = _open(o);
        if (doFill) _fill(orderId, originData, repay, 0);
        vm.warp(uint256(deadline) + 1 + uint256(later));

        bool settled;
        bool refunded;
        try origin.settle(originData, repay, "") {
            settled = true;
        } catch {}
        try origin.refund(originData, "") {
            refunded = true;
        } catch {}
        try origin.settle(originData, repay, "") {
            settled = false; // a second success would be a bug
            refunded = false;
        } catch {}

        assertTrue(settled != refunded);
        assertEq(settled, doFill);
        assertEq(tokenIn.balanceOf(address(origin)), 0);
        assertEq(tokenIn.balanceOf(repay) + tokenIn.balanceOf(user), 1_000e18);
    }
}
