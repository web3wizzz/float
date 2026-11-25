// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AgentVault} from "../src/AgentVault.sol";
import {InvoiceEscrow} from "../src/InvoiceEscrow.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";
import {EcdsaAgentAuth} from "../src/auth/EcdsaAgentAuth.sol";
import {MockTUSD8} from "../src/mocks/MockTUSD8.sol";

contract ReenteringToken is ERC20 {
    AgentVault public vault;
    bool internal entered;

    constructor() ERC20("Reenter", "RE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setVault(AgentVault next) external {
        vault = next;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from == address(vault) && !entered) {
            entered = true;
            vault.pay(to, 1, bytes32(0));
        }
    }
}

contract AgentVaultTest is Test {
    uint256 internal constant HOUR = 1 hours;

    MockTUSD8 internal token;
    EcdsaAgentAuth internal auth;
    AgentVault internal vault;
    InvoiceEscrow internal escrow;

    address internal owner;
    address internal agent;
    uint256 internal agentPk;
    address internal payee;
    address internal stranger;

    function setUp() public {
        vm.warp(1_700_000_000);
        owner = makeAddr("owner");
        (agent, agentPk) = makeAddrAndKey("agent");
        payee = makeAddr("payee");
        stranger = makeAddr("stranger");

        token = new MockTUSD8();
        assertEq(token.decimals(), 6);
        auth = new EcdsaAgentAuth();
        vault = new AgentVault(token, owner, auth);

        token.mint(owner, 1_000_000e6);
        vm.startPrank(owner);
        token.approve(address(vault), type(uint256).max);
        vault.deposit(10_000e6);
        vault.registerAgent(agent, 150e6, 400e6, 0, false);
        vault.setPayee(agent, payee, true);
        vm.stopPrank();
    }

    function test_payAsOwner_ignoresAgentPolicy() public {
        address other = makeAddr("other");
        vm.prank(owner);
        vault.payAsOwner(other, 500e6, bytes32("you"));
        assertEq(token.balanceOf(other), 500e6);
        assertEq(vault.spentInWindow(agent), 0);
    }

    function test_pay_ownerIsNotAnAgent() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.AgentNotActive.selector, owner));
        vault.pay(payee, 1e6, bytes32(0));
    }

    function test_pay_withinPolicy() public {
        vm.prank(agent);
        vault.pay(payee, 120e6, bytes32("INV-0142"));
        assertEq(token.balanceOf(payee), 120e6);
        assertEq(vault.spentInWindow(agent), 120e6);
        assertEq(token.balanceOf(address(vault)), 10_000e6 - 120e6);
    }

    function test_pay_revertsOverPerTx() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.PerTxLimitExceeded.selector, agent, 151e6, 150e6));
        vault.pay(payee, 151e6, bytes32(0));
    }

    function test_pay_revertsOverDaily() public {
        vm.startPrank(agent);
        vault.pay(payee, 150e6, bytes32(0));
        vault.pay(payee, 150e6, bytes32(0));
        vault.pay(payee, 100e6, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(AgentVault.DailyLimitExceeded.selector, agent, 400e6, 1, 400e6));
        vault.pay(payee, 1, bytes32(0));
        vm.stopPrank();
        assertEq(vault.spentInWindow(agent), 400e6);
    }

    function test_dailyWindow_rollsOffAfter24Hours() public {
        vm.prank(agent);
        vault.pay(payee, 150e6, bytes32(0));
        vm.warp(block.timestamp + 23 hours);
        vm.prank(agent);
        vault.pay(payee, 150e6, bytes32(0));
        assertEq(vault.spentInWindow(agent), 300e6);

        vm.warp(block.timestamp + 1 hours);
        // The first 150 has aged out; the second is still inside the window.
        assertEq(vault.spentInWindow(agent), 150e6);
        vm.prank(agent);
        vault.pay(payee, 150e6, bytes32(0));
        assertEq(vault.spentInWindow(agent), 300e6);
    }

    function test_payeeAllowlist_andAllowAny() public {
        address other = makeAddr("other");
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.PayeeNotAllowed.selector, agent, other));
        vault.pay(other, 1e6, bytes32(0));

        vm.prank(owner);
        vault.updatePolicy(agent, 150e6, 400e6, 0, true);
        vm.prank(agent);
        vault.pay(other, 1e6, bytes32(0));
        assertEq(token.balanceOf(other), 1e6);
    }

    function test_pauseRevokeExpiry() public {
        vm.prank(owner);
        vault.setAgentPaused(agent, true);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.AgentIsPaused.selector, agent));
        vault.pay(payee, 1e6, bytes32(0));

        vm.prank(owner);
        vault.setAgentPaused(agent, false);
        vm.prank(owner);
        vault.revokeAgent(agent);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.AgentNotActive.selector, agent));
        vault.pay(payee, 1e6, bytes32(0));

        vm.prank(owner);
        vault.registerAgent(agent, 150e6, 400e6, uint64(block.timestamp + 10), false);
        vm.prank(owner);
        vault.setPayee(agent, payee, true);
        vm.warp(block.timestamp + 11);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.AgentExpired.selector, agent, uint64(block.timestamp - 1)));
        vault.pay(payee, 1e6, bytes32(0));
    }

    function test_globalPause_blocksSpend_ownerCanStillWithdraw() public {
        vm.prank(owner);
        vault.setGlobalPaused(true);
        vm.prank(agent);
        vm.expectRevert(AgentVault.GloballyPaused.selector);
        vault.pay(payee, 1e6, bytes32(0));
        vm.prank(owner);
        vault.withdraw(10e6);
        assertEq(token.balanceOf(owner), 1_000_000e6 - 10_000e6 + 10e6);
    }

    function test_withdraw_cannotEatReserve() public {
        vm.prank(owner);
        uint256 id = vault.createSchedule(agent, payee, 100e6, 1 hours, 2, bytes32("rent"));
        assertEq(vault.reserved(), 200e6);
        vm.prank(owner);
        vm.expectRevert();
        vault.withdraw(10_000e6);
        vm.prank(owner);
        vault.withdraw(10_000e6 - 200e6);
        assertEq(token.balanceOf(address(vault)), 200e6);
        id;
    }

    function test_schedule_missedIntervalsChargeOnce() public {
        vm.prank(owner);
        uint256 id = vault.createSchedule(agent, payee, 50e6, 1 hours, 5, bytes32("week"));
        vm.warp(block.timestamp + 10 hours);
        vault.executeSchedule(id);
        assertEq(token.balanceOf(payee), 50e6);
        (,,,, uint64 nextRun,, uint32 runs, bool active,) = vault.schedules(id);
        assertEq(runs, 1);
        assertTrue(active);
        assertEq(nextRun, uint64(block.timestamp + 1 hours));
        vm.expectRevert(abi.encodeWithSelector(AgentVault.NotDue.selector, id, nextRun));
        vault.executeSchedule(id);
        assertEq(vault.reserved(), 200e6);

        vm.warp(block.timestamp + 1 hours);
        vault.executeSchedule(id);
        assertEq(token.balanceOf(payee), 100e6);
        (,,,, uint64 nextAfter,, uint32 runsAfter, bool stillActive,) = vault.schedules(id);
        assertEq(runsAfter, 2);
        assertTrue(stillActive);
        assertEq(nextAfter, uint64(block.timestamp + 1 hours));
        assertEq(vault.reserved(), 150e6);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.NotDue.selector, id, nextAfter));
        vault.executeSchedule(id);
        assertEq(token.balanceOf(payee), 100e6);
    }

    function test_schedule_agentCannotReserveAboveDaily() public {
        vm.prank(agent);
        vm.expectRevert();
        vault.createSchedule(agent, payee, 150e6, 1 hours, 3, bytes32(0));
        vm.prank(agent);
        uint256 id = vault.createSchedule(agent, payee, 100e6, 1 hours, 4, bytes32(0));
        assertEq(id, 1);
        assertEq(vault.reserved(), 400e6);
    }

    function test_intent_relayerAndReplay() public {
        AgentVault.PaymentIntent memory intent = AgentVault.PaymentIntent({
            agent: agent,
            payee: payee,
            amount: 40e6,
            memo: bytes32("relay"),
            nonce: 0,
            deadline: block.timestamp + 1 days
        });
        bytes32 digest = vault.hashIntent(intent);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(stranger);
        vault.executeIntent(intent, sig);
        assertEq(token.balanceOf(payee), 40e6);
        assertEq(vault.nonces(agent), 1);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.BadNonce.selector, 1, 0));
        vault.executeIntent(intent, sig);
    }

    function test_routerBatch() public {
        PaymentRouter router = new PaymentRouter();
        AgentVault.PaymentIntent[] memory intents = new AgentVault.PaymentIntent[](2);
        bytes[] memory sigs = new bytes[](2);
        intents[0] = AgentVault.PaymentIntent(agent, payee, 10e6, bytes32("a"), 0, block.timestamp + 1 days);
        intents[1] = AgentVault.PaymentIntent(agent, payee, 15e6, bytes32("b"), 1, block.timestamp + 1 days);
        for (uint256 i; i < 2; i++) {
            bytes32 digest = vault.hashIntent(intents[i]);
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, digest);
            sigs[i] = abi.encodePacked(r, s, v);
        }
        router.executeBatch(vault, intents, sigs);
        assertEq(token.balanceOf(payee), 25e6);
    }

    function test_batchPay_atomic() public {
        address second = makeAddr("second");
        vm.prank(owner);
        vault.setPayee(agent, second, true);
        address[] memory payees = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        bytes32[] memory memos = new bytes32[](2);
        payees[0] = payee;
        payees[1] = second;
        amounts[0] = 100e6;
        amounts[1] = 80e6;
        vm.prank(agent);
        vault.batchPay(payees, amounts, memos);
        assertEq(token.balanceOf(payee), 100e6);
        assertEq(token.balanceOf(second), 80e6);
        assertEq(vault.spentInWindow(agent), 180e6);
    }

    function test_escrowFundViaVault() public {
        escrow = new InvoiceEscrow(token, owner, owner);
        vm.prank(owner);
        vault.setEscrow(address(escrow));
        vm.prank(payee);
        uint256 id = escrow.createInvoice(address(vault), 90e6, uint64(block.timestamp + 2 days), keccak256("INV-0142"));
        vm.prank(agent);
        vault.fundInvoice(id);
        assertEq(token.balanceOf(address(escrow)), 90e6);
        assertEq(vault.spentInWindow(agent), 90e6);

        vm.prank(payee);
        escrow.markDelivered(id);
        vm.prank(owner);
        vault.confirmInvoice(id);
        assertEq(token.balanceOf(payee), 90e6);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_reentrancy_onPay_reverts() public {
        ReenteringToken bad = new ReenteringToken();
        EcdsaAgentAuth auth2 = new EcdsaAgentAuth();
        AgentVault v2 = new AgentVault(IERC20(address(bad)), owner, auth2);
        bad.setVault(v2);
        bad.mint(owner, 1_000e6);
        vm.startPrank(owner);
        bad.approve(address(v2), type(uint256).max);
        v2.deposit(500e6);
        v2.registerAgent(agent, 100e6, 100e6, 0, true);
        vm.stopPrank();
        vm.prank(agent);
        vm.expectRevert();
        v2.pay(payee, 10e6, bytes32(0));
        assertEq(bad.balanceOf(payee), 0);
    }

    function testFuzz_perTxAndDaily(uint128 perTx, uint128 daily, uint256 amount) public {
        perTx = uint128(bound(perTx, 1, 500e6));
        daily = uint128(bound(daily, perTx, 1_000e6));
        amount = bound(amount, 1, 2_000e6);
        vm.prank(owner);
        vault.updatePolicy(agent, perTx, daily, 0, true);
        vm.prank(agent);
        if (amount > perTx || amount > daily) {
            vm.expectRevert();
            vault.pay(payee, amount, bytes32(0));
        } else {
            vault.pay(payee, amount, bytes32(0));
            assertLe(vault.spentInWindow(agent), daily);
            assertEq(vault.spentInWindow(agent), amount);
        }
    }

    function testFuzz_splitPaysStayInsideDaily(uint128 daily, uint8 n, uint256 seed) public {
        daily = uint128(bound(daily, 1, 2_000e6));
        n = uint8(bound(n, 1, 12));
        vm.prank(owner);
        vault.updatePolicy(agent, daily, daily, 0, true);
        uint256 remaining = daily;
        for (uint256 i; i < n && remaining > 0; i++) {
            uint256 slice = uint256(keccak256(abi.encode(seed, i))) % (remaining + 1);
            if (slice == 0) continue;
            vm.prank(agent);
            vault.pay(payee, slice, bytes32(0));
            remaining -= slice;
            assertLe(vault.spentInWindow(agent), daily);
        }
        if (remaining == 0) {
            vm.prank(agent);
            vm.expectRevert();
            vault.pay(payee, 1, bytes32(0));
        }
    }

    function test_strangerCannotRegisterOrWithdraw() public {
        vm.prank(stranger);
        vm.expectRevert();
        vault.registerAgent(stranger, 1, 1, 0, true);
        vm.prank(stranger);
        vm.expectRevert();
        vault.withdraw(1);
    }

    function test_agentSchedulesShareOneDailyReserve() public {
        vm.startPrank(agent);
        vault.createSchedule(agent, payee, 100e6, 1 hours, 2, bytes32("a"));
        vault.createSchedule(agent, payee, 50e6, 1 hours, 4, bytes32("b"));
        assertEq(vault.agentReserved(agent), 400e6);
        assertEq(vault.reserved(), 400e6);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.AgentReserveCap.selector, 401e6, 400e6));
        vault.createSchedule(agent, payee, 1e6, 1 hours, 1, bytes32("c"));
        vm.stopPrank();

        vault.executeSchedule(1);
        assertEq(vault.agentReserved(agent), 300e6);
        vm.prank(agent);
        vault.createSchedule(agent, payee, 100e6, 1 hours, 1, bytes32("d"));
        assertEq(vault.agentReserved(agent), 400e6);

        vm.prank(agent);
        vault.cancelSchedule(2);
        assertEq(vault.agentReserved(agent), 200e6);
    }

    function test_ownerScheduleDoesNotConsumeAgentCap() public {
        vm.prank(owner);
        vault.createSchedule(agent, payee, 150e6, 1 hours, 10, bytes32("rent"));
        assertEq(vault.reserved(), 1_500e6);
        assertEq(vault.agentReserved(agent), 0);
        vm.prank(agent);
        vault.createSchedule(agent, payee, 100e6, 1 hours, 4, bytes32("agent"));
        assertEq(vault.agentReserved(agent), 400e6);
        assertEq(vault.reserved(), 1_900e6);
    }

    function test_pausedExpiredOrGlobalPauseBlocksAgentSchedule() public {
        vm.prank(owner);
        vault.setAgentPaused(agent, true);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.AgentIsPaused.selector, agent));
        vault.createSchedule(agent, payee, 10e6, 1 hours, 1, bytes32(0));
        vm.prank(owner);
        uint256 id = vault.createSchedule(agent, payee, 10e6, 1 hours, 1, bytes32("owner"));
        assertEq(vault.agentReserved(agent), 0);
        assertGt(id, 0);

        vm.prank(owner);
        vault.setAgentPaused(agent, false);
        vm.prank(owner);
        vault.setGlobalPaused(true);
        vm.prank(agent);
        vm.expectRevert(AgentVault.GloballyPaused.selector);
        vault.createSchedule(agent, payee, 10e6, 1 hours, 1, bytes32(0));

        vm.prank(owner);
        vault.setGlobalPaused(false);
        vm.prank(owner);
        vault.updatePolicy(agent, 150e6, 400e6, uint64(block.timestamp), false);
        vm.warp(block.timestamp + 1);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.AgentExpired.selector, agent, uint64(block.timestamp - 1)));
        vault.createSchedule(agent, payee, 10e6, 1 hours, 1, bytes32(0));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.AgentExpired.selector, agent, uint64(block.timestamp - 1)));
        vault.createSchedule(agent, payee, 10e6, 1 hours, 1, bytes32(0));
    }

    function test_scheduleReentrancyChargesNothing() public {
        ReenteringScheduleToken bad = new ReenteringScheduleToken();
        AgentVault v2 = new AgentVault(bad, owner, new EcdsaAgentAuth());
        bad.setVault(v2);
        bad.mint(owner, 1_000e6);
        vm.startPrank(owner);
        bad.approve(address(v2), type(uint256).max);
        v2.deposit(500e6);
        v2.registerAgent(agent, 100e6, 100e6, 0, true);
        uint256 id = v2.createSchedule(agent, payee, 10e6, 1 hours, 2, bytes32(0));
        vm.stopPrank();
        bad.setId(id);
        vm.expectRevert();
        v2.executeSchedule(id);
        assertEq(bad.balanceOf(payee), 0);
        (,,,,,, uint32 runs,,) = v2.schedules(id);
        assertEq(runs, 0);
        assertEq(v2.reserved(), 20e6);
    }

    function testFuzz_rollingWindowNeverExceedsDaily(uint32[8] calldata gaps, uint96[8] calldata amounts) public {
        uint256 daily = 1_000e6;
        vm.prank(owner);
        vault.updatePolicy(agent, uint128(daily), uint128(daily), 0, true);
        for (uint256 i; i < 8; ++i) {
            vm.warp(block.timestamp + bound(uint256(gaps[i]), 0, 36 hours));
            uint256 amount = bound(uint256(amounts[i]), 1, 1_500e6);
            uint256 spent = vault.spentInWindow(agent);
            vm.prank(agent);
            if (amount > daily) {
                vm.expectRevert(abi.encodeWithSelector(AgentVault.PerTxLimitExceeded.selector, agent, amount, daily));
                vault.pay(payee, amount, bytes32(0));
                assertEq(vault.spentInWindow(agent), spent);
            } else if (spent + amount > daily) {
                vm.expectRevert(
                    abi.encodeWithSelector(AgentVault.DailyLimitExceeded.selector, agent, spent, amount, daily)
                );
                vault.pay(payee, amount, bytes32(0));
                assertEq(vault.spentInWindow(agent), spent);
            } else {
                vault.pay(payee, amount, bytes32(0));
                assertEq(vault.spentInWindow(agent), spent + amount);
                assertLe(vault.spentInWindow(agent), daily);
            }
        }
    }

    function testFuzz_unlistedPayeeCannotBePaid(address to, uint96 raw) public {
        vm.assume(to != payee && to != address(0));
        uint256 amount = bound(uint256(raw), 1, 150e6);
        uint256 before = token.balanceOf(to);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.PayeeNotAllowed.selector, agent, to));
        vault.pay(to, amount, bytes32(0));
        assertEq(token.balanceOf(to), before);
        assertEq(token.balanceOf(address(vault)), 10_000e6);
    }

    function testFuzz_inactiveAgentCannotSpend(uint8 mode, uint96 raw) public {
        uint256 amount = bound(uint256(raw), 1, 150e6);
        uint8 which = mode % 4;
        if (which == 0) {
            vm.prank(owner);
            vault.setAgentPaused(agent, true);
        } else if (which == 1) {
            vm.prank(owner);
            vault.revokeAgent(agent);
        } else if (which == 2) {
            vm.prank(owner);
            vault.setGlobalPaused(true);
        } else {
            vm.prank(owner);
            vault.updatePolicy(agent, 150e6, 400e6, uint64(block.timestamp), false);
            vm.warp(block.timestamp + 1);
        }
        uint256 beforeVault = token.balanceOf(address(vault));
        uint256 beforePayee = token.balanceOf(payee);
        vm.prank(agent);
        vm.expectRevert();
        vault.pay(payee, amount, bytes32(0));
        assertEq(token.balanceOf(address(vault)), beforeVault);
        assertEq(token.balanceOf(payee), beforePayee);
    }

    function testFuzz_intentBoundToVaultChainAndNonce(uint96 raw) public {
        uint256 amount = bound(uint256(raw), 1, 100e6);
        AgentVault.PaymentIntent memory intent = AgentVault.PaymentIntent({
            agent: agent,
            payee: payee,
            amount: amount,
            memo: bytes32("bound"),
            nonce: vault.nonces(agent),
            deadline: block.timestamp + 1 days
        });
        bytes memory sig = _sign(intent);

        AgentVault.PaymentIntent memory tampered = AgentVault.PaymentIntent({
            agent: intent.agent,
            payee: intent.payee,
            amount: amount + 1,
            memo: intent.memo,
            nonce: intent.nonce,
            deadline: intent.deadline
        });
        vm.expectRevert(AgentVault.InvalidSignature.selector);
        vault.executeIntent(tampered, sig);

        uint256 original = block.chainid;
        vm.chainId(original == 44005 ? 44006 : 44005);
        vm.expectRevert(AgentVault.InvalidSignature.selector);
        vault.executeIntent(intent, sig);
        vm.chainId(original + 1);
        vm.expectRevert(AgentVault.InvalidSignature.selector);
        vault.executeIntent(intent, sig);
        vm.chainId(original);

        AgentVault other = new AgentVault(token, owner, auth);
        vm.expectRevert(AgentVault.InvalidSignature.selector);
        other.executeIntent(intent, sig);

        vault.executeIntent(intent, sig);
        assertEq(token.balanceOf(payee), amount);
        assertEq(vault.nonces(agent), intent.nonce + 1);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.BadNonce.selector, intent.nonce + 1, intent.nonce));
        vault.executeIntent(intent, sig);
        assertEq(token.balanceOf(payee), amount);
    }

    function testFuzz_lateScheduleChargesOnce(uint32 lateSecs, uint8 runs) public {
        uint128 amount = 50e6;
        uint32 maxRuns = uint32(bound(uint256(runs), 2, 6));
        uint256 late = bound(uint256(lateSecs), 1 hours, 10 days);
        vm.prank(owner);
        uint256 id = vault.createSchedule(agent, payee, amount, 1 hours, maxRuns, bytes32("s"));
        vm.warp(block.timestamp + late);
        vault.executeSchedule(id);
        assertEq(token.balanceOf(payee), amount);
        (,,,,,, uint32 done, bool active,) = vault.schedules(id);
        assertEq(done, 1);
        assertTrue(active);
        vm.expectRevert();
        vault.executeSchedule(id);
        assertEq(token.balanceOf(payee), amount);
        assertEq(vault.reserved(), uint256(amount) * (maxRuns - 1));
    }

    function testFuzz_withdrawRespectsReserve(uint96 scheduleAmt, uint32 runs, uint256 withdrawAmt) public {
        uint128 amount = uint128(bound(uint256(scheduleAmt), 1, 100e6));
        uint32 maxRuns = uint32(bound(uint256(runs), 1, 5));
        vm.prank(owner);
        vault.createSchedule(agent, payee, amount, 1 hours, maxRuns, bytes32(0));
        uint256 locked = uint256(amount) * maxRuns;
        uint256 bal = token.balanceOf(address(vault));
        withdrawAmt = bound(withdrawAmt, 1, bal);
        vm.prank(owner);
        if (withdrawAmt > bal - locked) {
            vm.expectRevert();
            vault.withdraw(withdrawAmt);
            assertEq(token.balanceOf(address(vault)), bal);
        } else {
            vault.withdraw(withdrawAmt);
            assertEq(token.balanceOf(address(vault)), bal - withdrawAmt);
            assertEq(vault.reserved(), locked);
        }
    }

    function test_batchPay_revertsAtomicallyWhenDailyExceeded() public {
        address second = makeAddr("second");
        address third = makeAddr("third");
        vm.startPrank(owner);
        vault.setPayee(agent, second, true);
        vault.setPayee(agent, third, true);
        vm.stopPrank();
        address[] memory payees = new address[](3);
        uint256[] memory amounts = new uint256[](3);
        bytes32[] memory memos = new bytes32[](3);
        payees[0] = payee;
        payees[1] = second;
        payees[2] = third;
        amounts[0] = 150e6;
        amounts[1] = 150e6;
        amounts[2] = 150e6;
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.DailyLimitExceeded.selector, agent, 300e6, 150e6, 400e6));
        vault.batchPay(payees, amounts, memos);
        assertEq(token.balanceOf(payee), 0);
        assertEq(token.balanceOf(second), 0);
        assertEq(token.balanceOf(third), 0);
        assertEq(vault.spentInWindow(agent), 0);
    }

    function _sign(AgentVault.PaymentIntent memory intent) internal view returns (bytes memory) {
        bytes32 digest = vault.hashIntent(intent);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, digest);
        return abi.encodePacked(r, s, v);
    }
}

contract ReenteringScheduleToken is ERC20 {
    AgentVault public vault;
    uint256 public id;
    bool internal entered;

    constructor() ERC20("ReenterSchedule", "RS") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setVault(AgentVault next) external {
        vault = next;
    }

    function setId(uint256 next) external {
        id = next;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from == address(vault) && !entered) {
            entered = true;
            vault.executeSchedule(id);
        }
    }
}
