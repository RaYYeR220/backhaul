// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Outbox, outboxKey} from "../../src/core/Outbox.sol";
import {OnchainCrossChainOrder} from "../../src/intents/ERC7683.sol";
import {BackhaulOrder, BackhaulOrders} from "../../src/intents/BackhaulOrder.sol";
import {OriginSettler} from "../../src/intents/OriginSettler.sol";
import {DestinationSettler} from "../../src/intents/DestinationSettler.sol";
import {LPVault} from "../../src/intents/LPVault.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockRemoteVerifier} from "../mocks/MockRemoteVerifier.sol";

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

/// Writes into the shared Outbox under an order id, hoping to pass for the origin settler.
contract OrderSpoofer {
    function spoof(Outbox o, bytes32 orderId) external {
        o.commit(orderId, orderId);
    }
}

/// Vaults on the destination chain ("BSC"); orders are opened on "Portaldot". The vaults'
/// verifier mirrors the Portaldot Outbox, so a fill goes through only for a really opened order.
contract LPVaultTest is Test {
    uint64 internal constant PORTALDOT = 420420777;
    uint64 internal constant BSC = 97;
    uint16 internal constant MIN_FEE = 30;

    Outbox internal outboxP;
    Outbox internal outboxB;
    MockRemoteVerifier internal verB; // on BSC, proves Portaldot
    OriginSettler internal origin; // on Portaldot
    DestinationSettler internal dest; // on BSC
    MockERC20 internal asset; // pPOT on BSC
    MockERC20 internal remoteToken; // an input token on Portaldot
    LPVault internal vault; // pPOT vault, repaid in native tPOT
    LPVault internal nvault; // native vault, repaid in remoteToken

    address internal anyone = makeAddr("anyone");
    address internal lp = makeAddr("lp");
    address internal lp2 = makeAddr("lp2");
    address internal user = makeAddr("user");
    address internal recipient = makeAddr("recipient");
    address internal forwarder = makeAddr("forwarder"); // where repayments land on Portaldot
    uint32 internal deadline;
    uint64 internal nonce;

    function setUp() public {
        vm.chainId(PORTALDOT);
        vm.warp(1_800_000_000);
        deadline = uint32(block.timestamp + 600);
        outboxP = new Outbox();
        outboxB = new Outbox();
        verB = new MockRemoteVerifier();
        verB.setMirror(address(outboxP));
        MockRemoteVerifier verP = new MockRemoteVerifier();
        verP.setMirror(address(outboxB));
        origin = new OriginSettler(verP, outboxP);
        dest = new DestinationSettler(outboxB, BSC);
        origin.setRemoteDestination(address(dest));

        asset = new MockERC20("Bridged Portaldot", "pPOT");
        remoteToken = new MockERC20("Remote", "RMT");

        vault = new LPVault(address(asset), dest, verB, MIN_FEE);
        vault.setRemote(forwarder, address(origin), address(0), PORTALDOT);
        nvault = new LPVault(address(0), dest, verB, MIN_FEE);
        nvault.setRemote(forwarder, address(origin), address(remoteToken), PORTALDOT);

        asset.mint(lp, 1_000e18);
        asset.mint(lp2, 1_000e18);
        vm.prank(lp);
        asset.approve(address(vault), type(uint256).max);
        vm.prank(lp2);
        asset.approve(address(vault), type(uint256).max);
        vm.deal(lp, 1_000e18);
        vm.deal(lp2, 1_000e18);
    }

    // ---------------------------------------------------------------- helpers

    function _encode(address inTok, uint256 inAmt, address outTok, uint256 outAmt, address to)
        internal
        returns (BackhaulOrder memory o, bytes32 orderId, bytes memory originData)
    {
        o = BackhaulOrder(user, inTok, inAmt, outTok, outAmt, to, BSC, ++nonce);
        originData = abi.encode(o, PORTALDOT, deadline);
        orderId = keccak256(originData);
    }

    /// Order data that was never opened anywhere.
    function _fabricate(address inTok, uint256 inAmt, address outTok, uint256 outAmt)
        internal
        returns (bytes32 orderId, bytes memory originData)
    {
        (, orderId, originData) = _encode(inTok, inAmt, outTok, outAmt, recipient);
    }

    function _open(address inTok, uint256 inAmt, address outTok, uint256 outAmt)
        internal
        returns (bytes32 orderId, bytes memory originData)
    {
        return _openTo(inTok, inAmt, outTok, outAmt, recipient);
    }

    function _openTo(address inTok, uint256 inAmt, address outTok, uint256 outAmt, address to)
        internal
        returns (bytes32 orderId, bytes memory originData)
    {
        BackhaulOrder memory o;
        (o, orderId, originData) = _encode(inTok, inAmt, outTok, outAmt, to);
        if (inTok == address(0)) {
            vm.deal(user, user.balance + inAmt);
        } else {
            MockERC20(inTok).mint(user, inAmt);
            vm.prank(user);
            MockERC20(inTok).approve(address(origin), inAmt);
        }
        vm.prank(user);
        origin.open{value: inTok == address(0) ? inAmt : 0}(
            OnchainCrossChainOrder(deadline, BackhaulOrders.ORDER_DATA_TYPE, abi.encode(o))
        );
    }

    function _fill(LPVault v, bytes32 orderId, bytes memory originData) internal {
        vm.prank(anyone);
        v.fill(orderId, originData, "");
    }

    function _deposit(LPVault v, address who, uint256 amount) internal returns (uint256 shares) {
        uint256 value = v.asset() == address(0) ? amount : 0;
        vm.prank(who);
        shares = v.deposit{value: value}(amount);
    }

    // ---------------------------------------------------------------- proof gating

    function test_vaultFillRequiresOpenProof() public {
        MockRemoteVerifier strict = new MockRemoteVerifier(); // accepts nothing by default
        LPVault v = new LPVault(address(asset), dest, strict, MIN_FEE);
        v.setRemote(forwarder, address(origin), address(0), PORTALDOT);
        vm.prank(lp);
        asset.approve(address(v), type(uint256).max);
        _deposit(v, lp, 100e18);

        (bytes32 id, bytes memory d) = _open(address(0), 10.05e18, address(asset), 10e18);
        vm.prank(anyone);
        vm.expectRevert(LPVault.InvalidProof.selector);
        v.fill(id, d, "");

        // the verifier is asked exactly for the origin settler's Open commitment
        strict.setCommitment(outboxKey(address(origin), id), keccak256(d), true);
        _fill(v, id, d);
        assertEq(asset.balanceOf(recipient), 10e18);
    }

    function test_openIsCommittedOnOrigin() public {
        (bytes32 id, bytes memory d) = _open(address(0), 10.05e18, address(asset), 10e18);
        assertEq(outboxP.commitments(outboxKey(address(origin), id)), keccak256(d));
    }

    function test_vaultFillPermissionless() public {
        _deposit(vault, lp, 100e18);
        (bytes32 id, bytes memory d) = _open(address(0), 10.05e18, address(asset), 10e18);
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vault.fill(id, d, "");

        assertEq(asset.balanceOf(recipient), 10e18);
        assertEq(asset.balanceOf(stranger), 0);
        assertTrue(dest.filled(id));
        // the repayment is pinned to the forwarder, whoever triggered the fill
        assertEq(outboxB.commitments(outboxKey(address(dest), id)), keccak256(abi.encode(forwarder)));
        assertEq(vault.idle(), 90e18);
        assertEq(vault.pendingRepay(), 10e18);
        assertEq(vault.totalAssets(), 100e18); // no paper gain at fill time
    }

    function test_vaultCannotFillFabricatedOrder() public {
        _deposit(vault, lp, 100e18);

        // never opened
        (bytes32 id, bytes memory d) = _fabricate(address(0), 50e18, address(asset), 40e18);
        vm.prank(anyone);
        vm.expectRevert(LPVault.InvalidProof.selector);
        vault.fill(id, d, "");

        // committed into the same Outbox, but by someone other than the origin settler
        OrderSpoofer s = new OrderSpoofer();
        s.spoof(outboxP, id);
        vm.prank(anyone);
        vm.expectRevert(LPVault.InvalidProof.selector);
        vault.fill(id, d, "");

        // a real order with the recipient swapped
        (bytes32 realId, bytes memory realData) = _open(address(0), 10.05e18, address(asset), 10e18);
        (BackhaulOrder memory o, uint64 chain, uint32 fd) = abi.decode(realData, (BackhaulOrder, uint64, uint32));
        o.recipient = anyone;
        bytes memory forged = abi.encode(o, chain, fd);
        vm.prank(anyone);
        vm.expectRevert(LPVault.InvalidProof.selector);
        vault.fill(realId, forged, "");
        vm.prank(anyone);
        vm.expectRevert(LPVault.InvalidProof.selector);
        vault.fill(keccak256(forged), forged, "");

        assertEq(vault.idle(), 100e18);
        assertEq(asset.balanceOf(anyone), 0);
        assertEq(asset.balanceOf(recipient), 0);
    }

    function test_vaultFillTwiceReverts() public {
        _deposit(vault, lp, 100e18);
        (bytes32 id, bytes memory d) = _open(address(0), 10.05e18, address(asset), 10e18);
        _fill(vault, id, d);
        vm.prank(anyone);
        vm.expectRevert(DestinationSettler.AlreadyFilled.selector);
        vault.fill(id, d, "");

        // an order a fast solver already filled can't be filled again by the vault
        (bytes32 id2, bytes memory d2) = _open(address(0), 10.05e18, address(asset), 10e18);
        address solver = makeAddr("solver");
        asset.mint(solver, 10e18);
        vm.startPrank(solver);
        asset.approve(address(dest), 10e18);
        dest.fill(id2, d2, abi.encode(solver));
        vm.stopPrank();
        vm.prank(anyone);
        vm.expectRevert(DestinationSettler.AlreadyFilled.selector);
        vault.fill(id2, d2, "");

        assertEq(vault.pendingRepay(), 10e18);
        assertEq(asset.balanceOf(recipient), 20e18);
    }

    // ---------------------------------------------------------------- order checks

    function test_vaultCannotFillUnprofitable() public {
        _deposit(vault, lp, 100e18);
        // 9.98 out for 10 in is 20 bps, below the 30 bps floor
        (bytes32 id, bytes memory d) = _open(address(0), 10e18, address(asset), 9.98e18);
        vm.prank(anyone);
        vm.expectRevert(LPVault.Unprofitable.selector);
        vault.fill(id, d, "");

        // input below output
        (id, d) = _open(address(0), 9e18, address(asset), 10e18);
        vm.prank(anyone);
        vm.expectRevert(LPVault.Unprofitable.selector);
        vault.fill(id, d, "");

        // exactly at the floor: in * 1e4 == out * (1e4 + 30)
        (id, d) = _open(address(0), 10.03e18, address(asset), 10e18);
        _fill(vault, id, d);
        assertEq(asset.balanceOf(recipient), 10e18);
    }

    function testFuzz_vaultNeverFillsBelowFloor(uint96 inAmt, uint96 outAmt) public {
        vm.assume(inAmt > 0 && outAmt > 0 && outAmt <= 100e18);
        _deposit(vault, lp, 100e18);
        (bytes32 id, bytes memory d) = _open(address(0), inAmt, address(asset), outAmt);
        bool profitable = uint256(inAmt) * 10_000 >= uint256(outAmt) * (10_000 + MIN_FEE);
        vm.prank(anyone);
        if (!profitable) vm.expectRevert(LPVault.Unprofitable.selector);
        vault.fill(id, d, "");
    }

    function test_vaultRouteChecks() public {
        _deposit(vault, lp, 100e18);

        (bytes32 id, bytes memory d) = _open(address(0), 20e18, address(remoteToken), 10e18);
        vm.prank(anyone);
        vm.expectRevert(LPVault.WrongAsset.selector);
        vault.fill(id, d, "");

        (id, d) = _open(address(remoteToken), 20e18, address(asset), 10e18); // wrong input token
        vm.prank(anyone);
        vm.expectRevert(LPVault.WrongRoute.selector);
        vault.fill(id, d, "");

        BackhaulOrder memory o = BackhaulOrder(user, address(0), 20e18, address(asset), 10e18, recipient, BSC, 99);
        d = abi.encode(o, uint64(56), deadline); // repaid on a chain where the forwarder isn't ours
        vm.prank(anyone);
        vm.expectRevert(LPVault.WrongRoute.selector);
        vault.fill(keccak256(d), d, "");

        // more than the vault holds
        (id, d) = _open(address(0), 2_000e18, address(asset), 101e18);
        vm.prank(anyone);
        vm.expectRevert(LPVault.InsufficientIdle.selector);
        vault.fill(id, d, "");

        assertEq(vault.idle(), 100e18);
    }

    /// Nobody, not even the deployer, can move LP funds except into a proven, profitable order.
    function test_noOneCanWithdrawOthersShares() public {
        _deposit(vault, lp, 100e18);
        vm.prank(anyone);
        vm.expectRevert(LPVault.InsufficientShares.selector);
        vault.withdraw(1);
        vm.expectRevert(LPVault.InsufficientShares.selector);
        vault.withdraw(1);
        assertEq(asset.balanceOf(address(vault)), 100e18);
        assertEq(asset.allowance(address(vault), anyone), 0);
        assertEq(asset.allowance(address(vault), address(this)), 0);
    }

    // ---------------------------------------------------------------- shares and repayment

    function test_vaultSharesAccrueFee() public {
        uint256 shares = _deposit(vault, lp, 100e18);
        (bytes32 id, bytes memory d) = _open(address(0), 10.05e18, address(asset), 10e18);
        _fill(vault, id, d);

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
        (bytes32 id, bytes memory d) = _open(address(0), 10.05e18, address(asset), 10e18);
        _fill(vault, id, d);
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
        (bytes32 id, bytes memory d) = _open(address(0), 60e18, address(asset), 50e18);
        _fill(vault, id, d);
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
        (bytes32 id, bytes memory d) = _open(address(remoteToken), 10.05e18, address(0), 10e18);
        _fill(nvault, id, d);
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
        (bytes32 id, bytes memory d) = _openTo(address(remoteToken), 10.05e18, address(0), 10e18, address(g));
        _fill(nvault, id, d);

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
        LPVault v = new LPVault(address(asset), dest, verB, MIN_FEE);
        (bytes32 id, bytes memory d) = _open(address(0), 20e18, address(asset), 10e18);
        vm.prank(anyone);
        vm.expectRevert(LPVault.NotWired.selector);
        v.fill(id, d, "");

        vm.prank(anyone);
        vm.expectRevert(LPVault.NotDeployer.selector);
        v.setRemote(anyone, address(origin), address(0), PORTALDOT);
        vm.expectRevert(LPVault.ZeroAddress.selector);
        v.setRemote(address(0), address(origin), address(0), PORTALDOT);
        vm.expectRevert(LPVault.ZeroAddress.selector);
        v.setRemote(forwarder, address(0), address(0), PORTALDOT);
        v.setRemote(forwarder, address(origin), address(0), PORTALDOT);
        vm.expectRevert(LPVault.RemoteAlreadySet.selector);
        v.setRemote(anyone, anyone, address(0), PORTALDOT);
        assertEq(v.remoteVault(), forwarder);
        assertEq(v.remoteOriginSettler(), address(origin));
    }
}
