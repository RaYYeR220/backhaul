// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Outbox, outboxKey} from "../../src/core/Outbox.sol";
import {BackhaulOrder} from "../../src/intents/BackhaulOrder.sol";
import {DestinationSettler} from "../../src/intents/DestinationSettler.sol";
import {LPVault} from "../../src/intents/LPVault.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// An LP that is also an order recipient and pulls its shares out while being paid by a fill.
contract GreedyLp {
    LPVault internal v;
    bool internal armed;
    uint256 public got;

    constructor(LPVault v_) payable {
        v = v_;
    }

    function join(uint256 a) external {
        v.deposit{value: a}(a);
    }

    function arm() external {
        armed = true;
    }

    receive() external payable {
        if (!armed) return;
        armed = false;
        got = v.withdraw(v.sharesOf(address(this)));
    }
}

/// Vault on the destination chain ("BSC"); orders come from "Portaldot".
contract LPVaultTest is Test {
    uint64 internal constant PORTALDOT = 420420777;
    uint64 internal constant BSC = 97;
    uint16 internal constant MIN_FEE = 30;

    Outbox internal outboxB;
    DestinationSettler internal dest;
    MockERC20 internal asset;
    LPVault internal vault; // ERC-20 asset
    LPVault internal nvault; // native asset

    address internal operator = makeAddr("operator");
    address internal lp = makeAddr("lp");
    address internal lp2 = makeAddr("lp2");
    address internal user = makeAddr("user");
    address internal recipient = makeAddr("recipient");
    address internal forwarder = makeAddr("forwarder"); // where repayments land on Portaldot
    address internal remoteToken = makeAddr("remoteToken"); // input token on Portaldot
    uint32 internal deadline;

    function setUp() public {
        vm.warp(1_800_000_000);
        deadline = uint32(block.timestamp + 600);
        outboxB = new Outbox();
        dest = new DestinationSettler(outboxB, BSC);
        asset = new MockERC20("Bridged Portaldot", "pPOT");

        vault = new LPVault(address(asset), dest, operator, MIN_FEE);
        vault.setRemote(forwarder, address(0), PORTALDOT); // repaid in native tPOT on Portaldot
        nvault = new LPVault(address(0), dest, operator, MIN_FEE);
        nvault.setRemote(forwarder, remoteToken, PORTALDOT);

        asset.mint(lp, 1_000e18);
        asset.mint(lp2, 1_000e18);
        vm.prank(lp);
        asset.approve(address(vault), type(uint256).max);
        vm.prank(lp2);
        asset.approve(address(vault), type(uint256).max);
        vm.deal(lp, 1_000e18);
        vm.deal(lp2, 1_000e18);
    }

    function _data(address inTok, uint256 inAmt, address outTok, uint256 outAmt)
        internal
        view
        returns (bytes32 orderId, bytes memory originData)
    {
        BackhaulOrder memory o = BackhaulOrder(user, inTok, inAmt, outTok, outAmt, recipient, BSC, 1);
        originData = abi.encode(o, PORTALDOT, deadline);
        orderId = keccak256(originData);
    }

    function _deposit(LPVault v, address who, uint256 amount) internal returns (uint256 shares) {
        uint256 value = v.asset() == address(0) ? amount : 0;
        vm.prank(who);
        shares = v.deposit{value: value}(amount);
    }

    // ---------------------------------------------------------------- operator limits

    function test_vaultOperatorCannotFillUnprofitable() public {
        _deposit(vault, lp, 100e18);
        // 9.98 out for 10 in is 20 bps, below the 30 bps floor
        (bytes32 id, bytes memory d) = _data(address(0), 10e18, address(asset), 9.98e18);
        vm.prank(operator);
        vm.expectRevert(LPVault.Unprofitable.selector);
        vault.fill(id, d);

        // input below output
        (id, d) = _data(address(0), 9e18, address(asset), 10e18);
        vm.prank(operator);
        vm.expectRevert(LPVault.Unprofitable.selector);
        vault.fill(id, d);

        // exactly at the floor: in * 1e4 == out * (1e4 + 30)
        (id, d) = _data(address(0), 10.03e18, address(asset), 10e18);
        vm.prank(operator);
        vault.fill(id, d);
        assertEq(asset.balanceOf(recipient), 10e18);
    }

    function testFuzz_vaultNeverFillsBelowFloor(uint96 inAmt, uint96 outAmt) public {
        vm.assume(outAmt > 0 && outAmt <= 100e18);
        _deposit(vault, lp, 100e18);
        (bytes32 id, bytes memory d) = _data(address(0), inAmt, address(asset), outAmt);
        bool profitable = uint256(inAmt) * 10_000 >= uint256(outAmt) * (10_000 + MIN_FEE);
        vm.prank(operator);
        if (!profitable) vm.expectRevert(LPVault.Unprofitable.selector);
        vault.fill(id, d);
    }

    function test_vaultOperatorCannotWithdraw() public {
        _deposit(vault, lp, 100e18);
        uint256 before = asset.balanceOf(address(vault));

        vm.startPrank(operator);
        vm.expectRevert(LPVault.InsufficientShares.selector);
        vault.withdraw(1);

        // can't route the vault's asset anywhere but a profitable order of the pinned route
        (bytes32 id, bytes memory d) = _data(address(0), 20e18, address(0xdead), 10e18);
        vm.expectRevert(LPVault.WrongAsset.selector);
        vault.fill(id, d);

        (id, d) = _data(remoteToken, 20e18, address(asset), 10e18); // wrong input token
        vm.expectRevert(LPVault.WrongRoute.selector);
        vault.fill(id, d);

        BackhaulOrder memory o = BackhaulOrder(user, address(0), 20e18, address(asset), 10e18, recipient, BSC, 1);
        d = abi.encode(o, uint64(56), deadline); // repaid on a chain where the forwarder isn't ours
        vm.expectRevert(LPVault.WrongRoute.selector);
        vault.fill(keccak256(d), d);

        // more than the vault holds
        (id, d) = _data(address(0), 2_000e18, address(asset), 101e18);
        vm.expectRevert(LPVault.InsufficientIdle.selector);
        vault.fill(id, d);
        vm.stopPrank();

        // nobody else can fill
        (id, d) = _data(address(0), 20e18, address(asset), 10e18);
        vm.prank(lp);
        vm.expectRevert(LPVault.NotOperator.selector);
        vault.fill(id, d);

        assertEq(asset.balanceOf(address(vault)), before);
        assertEq(asset.balanceOf(operator), 0);
        assertEq(asset.allowance(address(vault), operator), 0);
    }

    /// The operator can be an LP like anyone else, but only takes out its own share.
    function test_operatorAsLpOnlyGetsOwnShare() public {
        _deposit(vault, lp, 100e18);
        asset.mint(operator, 10e18);
        vm.startPrank(operator);
        asset.approve(address(vault), 10e18);
        uint256 shares = vault.deposit(10e18);
        vault.withdraw(shares);
        vm.expectRevert(LPVault.InsufficientShares.selector);
        vault.withdraw(1);
        vm.stopPrank();
        assertLe(asset.balanceOf(operator), 10e18);
        assertGe(vault.totalAssets(), 100e18);
    }

    // ---------------------------------------------------------------- fills and repayment

    function test_vaultFillGoesThroughSettler() public {
        _deposit(vault, lp, 100e18);
        (bytes32 id, bytes memory d) = _data(address(0), 10.05e18, address(asset), 10e18);
        vm.prank(operator);
        vault.fill(id, d);
        assertEq(asset.balanceOf(recipient), 10e18);
        assertTrue(dest.filled(id));
        // the solver repayment is pinned to the forwarder
        assertEq(outboxB.commitments(outboxKey(address(dest), id)), keccak256(abi.encode(forwarder)));
        assertEq(vault.idle(), 90e18);
        assertEq(vault.pendingRepay(), 10e18);
        assertEq(vault.totalAssets(), 100e18); // no paper gain at fill time

        vm.prank(operator);
        vm.expectRevert(DestinationSettler.AlreadyFilled.selector);
        vault.fill(id, d);
    }

    function test_vaultSharesAccrueFee() public {
        uint256 shares = _deposit(vault, lp, 100e18);
        (bytes32 id, bytes memory d) = _data(address(0), 10.05e18, address(asset), 10e18);
        vm.prank(operator);
        vault.fill(id, d);

        // repayment comes home through the canonical bridge (minted/transferred to the vault)
        asset.mint(address(vault), 10.04e18);
        assertEq(vault.totalAssets(), 100.04e18); // view already counts it
        vault.notifyRepaid();
        assertEq(vault.pendingRepay(), 0);
        assertEq(vault.idle(), 100.04e18);

        vm.prank(lp);
        uint256 out = vault.withdraw(shares);
        assertApproxEqAbs(out, 100.04e18, 1e7);
        assertGt(out, 100e18);
    }

    function test_lateLpDoesNotDiluteEarnedFee() public {
        uint256 s1 = _deposit(vault, lp, 100e18);
        (bytes32 id, bytes memory d) = _data(address(0), 10.05e18, address(asset), 10e18);
        vm.prank(operator);
        vault.fill(id, d);
        asset.mint(address(vault), 10.05e18); // repaid, not yet synced
        uint256 s2 = _deposit(vault, lp2, 100e18); // deposit syncs first
        assertLt(s2, s1);

        vm.prank(lp);
        uint256 a1 = vault.withdraw(s1);
        vm.prank(lp2);
        uint256 a2 = vault.withdraw(s2);
        assertApproxEqAbs(a1, 100.05e18, 1e7);
        assertApproxEqAbs(a2, 100e18, 1e7);
        assertLe(a2, 100e18);
    }

    function test_withdrawLimitedToIdle() public {
        uint256 shares = _deposit(vault, lp, 100e18);
        (bytes32 id, bytes memory d) = _data(address(0), 60e18, address(asset), 50e18);
        vm.prank(operator);
        vault.fill(id, d);
        vm.prank(lp);
        vm.expectRevert(LPVault.InsufficientIdle.selector);
        vault.withdraw(shares);
        vm.prank(lp);
        uint256 got = vault.withdraw(shares / 2);
        assertApproxEqAbs(got, 50e18, 1e7);
    }

    function test_donationWhileNothingPendingIsGain() public {
        uint256 shares = _deposit(vault, lp, 100e18);
        asset.mint(address(vault), 1e18);
        vault.notifyRepaid();
        assertEq(vault.totalAssets(), 101e18);
        vm.prank(lp);
        assertApproxEqAbs(vault.withdraw(shares), 101e18, 1e7);
    }

    /// First-depositor donation trick: the virtual-share offset makes it cost the attacker
    /// far more than the victim loses.
    function test_inflationAttackBlunted() public {
        asset.mint(address(this), 1_000e18);
        asset.approve(address(vault), type(uint256).max);
        vault.deposit(1);
        asset.transfer(address(vault), 100e18);
        vault.notifyRepaid();

        uint256 s = _deposit(vault, lp, 10e18);
        assertGt(s, 0);
        vm.prank(lp);
        uint256 back = vault.withdraw(s);
        assertGe(back, 10e18 - 10e18 / 1e5);
    }

    function test_zeroDepositAndDustSharesRevert() public {
        vm.prank(lp);
        vm.expectRevert(LPVault.ZeroAmount.selector);
        vault.deposit(0);
        vm.prank(lp);
        vm.expectRevert(LPVault.InsufficientShares.selector);
        vault.withdraw(0);
    }

    function testFuzz_depositWithdrawNeverProfits(uint96 a, uint96 b) public {
        uint256 x = bound(uint256(a), 1, 1_000e18);
        uint256 y = bound(uint256(b), 1, 1_000e18);
        uint256 s1 = _deposit(vault, lp, x);
        uint256 s2 = _deposit(vault, lp2, y);
        vm.prank(lp);
        uint256 x2 = vault.withdraw(s1);
        vm.prank(lp2);
        uint256 y2 = vault.withdraw(s2);
        assertLe(x2, x);
        assertLe(y2, y);
        assertLe(x2 + y2, x + y);
        assertGe(asset.balanceOf(address(vault)), x + y - x2 - y2);
    }

    // ---------------------------------------------------------------- native vault

    function test_nativeVaultFillAndRepayViaReceive() public {
        uint256 shares = _deposit(nvault, lp, 100e18);
        assertEq(address(nvault).balance, 100e18);
        (bytes32 id, bytes memory d) = _data(remoteToken, 10.05e18, address(0), 10e18);
        vm.prank(operator);
        nvault.fill(id, d);
        assertEq(recipient.balance, 10e18);
        assertEq(nvault.pendingRepay(), 10e18);

        // the canonical bridge releases native with a plain call
        vm.deal(address(this), 10.05e18);
        (bool ok,) = address(nvault).call{value: 10.05e18}("");
        assertTrue(ok);
        assertEq(nvault.pendingRepay(), 0);
        assertEq(nvault.totalAssets(), 100.05e18);

        uint256 before = lp.balance;
        vm.prank(lp);
        nvault.withdraw(shares);
        assertApproxEqAbs(lp.balance - before, 100.05e18, 1e7);
    }

    function test_reentrantWithdrawDuringFillGetsFairShare() public {
        _deposit(nvault, lp, 100e18);
        GreedyLp g = new GreedyLp{value: 10e18}(nvault);
        g.join(10e18);
        g.arm();
        BackhaulOrder memory o = BackhaulOrder(user, remoteToken, 10.05e18, address(0), 10e18, address(g), BSC, 1);
        bytes memory d = abi.encode(o, PORTALDOT, deadline);
        vm.prank(operator);
        nvault.fill(keccak256(d), d);

        assertApproxEqAbs(g.got(), 10e18, 1e7);
        assertLe(g.got(), 10e18);
        assertEq(address(g).balance, 10e18 + g.got());
        assertEq(nvault.idle(), address(nvault).balance);
        assertEq(nvault.pendingRepay(), 10e18);

        vm.deal(address(this), 10.05e18);
        (bool ok,) = address(nvault).call{value: 10.05e18}("");
        assertTrue(ok);
        uint256 shares = nvault.sharesOf(lp);
        vm.prank(lp);
        assertApproxEqAbs(nvault.withdraw(shares), 100.05e18, 1e7);
    }

    function test_nativeVaultDepositValueMustMatch() public {
        vm.prank(lp);
        vm.expectRevert(LPVault.WrongValue.selector);
        nvault.deposit{value: 1e18}(2e18);
        vm.prank(lp);
        vm.expectRevert(LPVault.WrongValue.selector);
        vault.deposit{value: 1}(1);
    }

    function test_erc20VaultRejectsNative() public {
        vm.deal(address(this), 1);
        (bool ok,) = address(vault).call{value: 1}("");
        assertFalse(ok);
    }

    // ---------------------------------------------------------------- wiring

    function test_vaultSetRemoteOnce() public {
        LPVault v = new LPVault(address(asset), dest, operator, MIN_FEE);
        (bytes32 id, bytes memory d) = _data(address(0), 20e18, address(asset), 10e18);
        vm.prank(operator);
        vm.expectRevert(LPVault.NotWired.selector);
        v.fill(id, d);

        vm.prank(operator);
        vm.expectRevert(LPVault.NotDeployer.selector);
        v.setRemote(operator, address(0), PORTALDOT);
        vm.expectRevert(LPVault.ZeroAddress.selector);
        v.setRemote(address(0), address(0), PORTALDOT);
        v.setRemote(forwarder, address(0), PORTALDOT);
        vm.expectRevert(LPVault.RemoteAlreadySet.selector);
        v.setRemote(operator, address(0), PORTALDOT);
        assertEq(v.remoteVault(), forwarder);
    }
}
