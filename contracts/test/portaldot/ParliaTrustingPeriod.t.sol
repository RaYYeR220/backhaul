// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ParliaClient} from "../../src/portaldot/ParliaClient.sol";
import {ParliaSynth} from "./ParliaSynth.sol";

/// The trusting period runs on Portaldot's clock as well as on the signed header timestamps: a set
/// is trusted for a trusting period from the moment the client installed it, whatever its keys
/// stamp into the headers they seal.
contract ParliaTrustingPeriodTest is ParliaSynth {
    /// The deployment default.
    uint64 internal constant PERIOD = 14 days;
    /// Portaldot time of the deployment. (Kept in a constant: under via-ir a `block.timestamp`
    /// held in a local can be re-read after a warp.)
    uint64 internal constant DEPLOYED = 1_800_000_000;

    function setUp() public override {
        super.setUp();
        vm.warp(DEPLOYED);
    }

    /// Keys of a set the client has held for longer than a trusting period (here the checkpoint
    /// set, never refreshed) cannot finalize anything, not even a forged chain stamped with times
    /// inside the period of its epoch block.
    function test_staleSetCannotForgeAfterThePeriod() public {
        uint64 installed = DEPLOYED;
        ParliaClient lc = _client(PERIOD);
        bytes[] memory forged = _forgedSegment(50_001, 48, T0 + 3600, bytes32(uint256(0xbad)));

        vm.warp(installed + 365 days);
        vm.expectRevert(
            abi.encodeWithSelector(
                ParliaClient.TrustedSetExpired.selector, uint64(installed + 365 days), uint64(installed + PERIOD)
            )
        );
        lc.submitWindow(forged);
        vm.expectRevert(abi.encodeWithSelector(ParliaClient.NotFinalized.selector, 50_001));
        lc.finalized(50_001);
    }

    function test_windowUpToTheDeadline() public {
        uint64 installed = DEPLOYED;
        ParliaClient lc = _client(PERIOD);
        (,,,,, uint64 installedAt) = lc.validatorSet();
        assertEq(installedAt, installed);
        bytes[] memory w = _segment(1100, 48, false);

        vm.warp(installed + PERIOD + 1);
        vm.expectRevert(
            abi.encodeWithSelector(ParliaClient.TrustedSetExpired.selector, uint64(installed + PERIOD + 1), uint64(installed + PERIOD))
        );
        lc.submitWindow(w);

        vm.warp(installed + PERIOD);
        assertEq(lc.submitWindow(w), 1100, "exactly at the deadline");
    }

    /// A rotation within the period installs the new set now, which restarts its period; the set
    /// it replaced keeps its own, older deadline for the heights it still checks.
    function test_rotationRestartsThePeriod() public {
        uint64 t = DEPLOYED;
        ParliaClient lc = _client(PERIOD);

        vm.warp(t + 13 days);
        lc.submitWindow(_segment(2000, 56, true));
        (,, uint64 epoch,,, uint64 installedAt) = lc.validatorSet();
        assertEq(epoch, 2000);
        assertEq(installedAt, t + 13 days);
        (,,,,, uint64 previousInstalledAt) = lc.previousValidatorSet();
        assertEq(previousInstalledAt, t);

        // Past the checkpoint's deadline: the new set still finalizes above its first height (2040)…
        vm.warp(t + 20 days);
        assertEq(lc.submitWindow(_segment(2100, 48, false)), 2100);
        // …while the checkpoint set, kept for the heights below it, has expired.
        bytes[] memory old = _segment(1500, 48, false);
        vm.expectRevert(
            abi.encodeWithSelector(ParliaClient.TrustedSetExpired.selector, uint64(t + 20 days), uint64(t + PERIOD))
        );
        lc.submitWindow(old);

        // A trusting period after the last rotation the client accepts nothing, not even an epoch.
        uint64 late = t + 13 days + PERIOD + 1;
        vm.warp(late);
        bytes[] memory epoch3000 = _segment(3000, 48, true);
        vm.expectRevert(
            abi.encodeWithSelector(ParliaClient.TrustedSetExpired.selector, uint64(late), uint64(t + 13 days + PERIOD))
        );
        lc.submitWindow(epoch3000);
    }
}
