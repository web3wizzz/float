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
        auth = new EcdsaAgentAuth();
        vault = new AgentVault(token, owner, auth);

        token.mint(owner, 1_000_000e8);
        vm.startPrank(owner);
        token.approve(address(vault), type(uint256).max);
        vault.deposit(10_000e8);
        vault.registerAgent(agent, 150e8, 400e8, 0, false);
        vault.setPayee(agent, payee, true);
        vm.stopPrank();
    }

    function test_pay_withinPolicy() public {
        vm.prank(agent);
        vault.pay(payee, 120e8, bytes32("INV-0142"));
        assertEq(token.balanceOf(payee), 120e8);
        assertEq(vault.spentInWindow(agent), 120e8);
        assertEq(token.balanceOf(address(vault)), 10_000e8 - 120e8);
    }

    function test_pay_revertsOverPerTx() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.PerTxLimitExceeded.selector, agent, 151e8, 150e8));
        vault.pay(payee, 151e8, bytes32(0));
    }

    function test_pay_revertsOverDaily() public {
        vm.startPrank(agent);
        vault.pay(payee, 150e8, bytes32(0));
        vault.pay(payee, 150e8, bytes32(0));
        vault.pay(payee, 100e8, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(AgentVault.DailyLimitExceeded.selector, agent, 400e8, 1, 400e8));
        vault.pay(payee, 1, bytes32(0));
        vm.stopPrank();
        assertEq(vault.spentInWindow(agent), 400e8);
    }

    function test_dailyWindow_rollsOffAfter24Hours() public {
        vm.prank(agent);
        vault.pay(payee, 150e8, bytes32(0));
        vm.warp(block.timestamp + 23 hours);
        vm.prank(agent);
        vault.pay(payee, 150e8, bytes32(0));
        assertEq(vault.spentInWindow(agent), 300e8);

        vm.warp(block.timestamp + 1 hours);
        // The first 150 has aged out; the second is still inside the window.
        assertEq(vault.spentInWindow(agent), 150e8);
        vm.prank(agent);
        vault.pay(payee, 150e8, bytes32(0));
        assertEq(vault.spentInWindow(agent), 300e8);
    }

    function test_payeeAllowlist_andAllowAny() public {
        address other = makeAddr("other");
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.PayeeNotAllowed.selector, agent, other));
        vault.pay(other, 1e8, bytes32(0));

        vm.prank(owner);
        vault.updatePolicy(agent, 150e8, 400e8, 0, true);
        vm.prank(agent);
        vault.pay(other, 1e8, bytes32(0));
        assertEq(token.balanceOf(other), 1e8);
    }

    function test_pauseRevokeExpiry() public {
        vm.prank(owner);
        vault.setAgentPaused(agent, true);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.AgentIsPaused.selector, agent));
        vault.pay(payee, 1e8, bytes32(0));

        vm.prank(owner);
        vault.setAgentPaused(agent, false);
        vm.prank(owner);
        vault.revokeAgent(agent);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.AgentNotActive.selector, agent));
        vault.pay(payee, 1e8, bytes32(0));

        vm.prank(owner);
        vault.registerAgent(agent, 150e8, 400e8, uint64(block.timestamp + 10), false);
        vm.prank(owner);
        vault.setPayee(agent, payee, true);
        vm.warp(block.timestamp + 11);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.AgentExpired.selector, agent, uint64(block.timestamp - 1)));
        vault.pay(payee, 1e8, bytes32(0));
    }

    function test_globalPause_blocksSpend_ownerCanStillWithdraw() public {
        vm.prank(owner);
        vault.setGlobalPaused(true);
        vm.prank(agent);
        vm.expectRevert(AgentVault.GloballyPaused.selector);
        vault.pay(payee, 1e8, bytes32(0));
        vm.prank(owner);
        vault.withdraw(10e8);
        assertEq(token.balanceOf(owner), 1_000_000e8 - 10_000e8 + 10e8);
    }

    function test_withdraw_cannotEatReserve() public {
        vm.prank(owner);
        uint256 id = vault.createSchedule(agent, payee, 100e8, 1 hours, 2, bytes32("rent"));
        assertEq(vault.reserved(), 200e8);
        vm.prank(owner);
        vm.expectRevert();
        vault.withdraw(10_000e8);
        vm.prank(owner);
        vault.withdraw(10_000e8 - 200e8);
        assertEq(token.balanceOf(address(vault)), 200e8);
        id;
    }

    function test_schedule_missedIntervalsChargeOnce() public {
        vm.prank(owner);
        uint256 id = vault.createSchedule(agent, payee, 50e8, 1 hours, 5, bytes32("week"));
        vm.warp(block.timestamp + 10 hours);
        vault.executeSchedule(id);
        assertEq(token.balanceOf(payee), 50e8);
        (, , , , uint64 nextRun, , uint32 runs, bool active,) = vault.schedules(id);
        assertEq(runs, 1);
        assertTrue(active);
        assertEq(nextRun, uint64(block.timestamp + 1 hours));
        vm.expectRevert(abi.encodeWithSelector(AgentVault.NotDue.selector, id, nextRun));
        vault.executeSchedule(id);
        assertEq(vault.reserved(), 200e8);

        vm.warp(block.timestamp + 1 hours);
        vault.executeSchedule(id);
        assertEq(token.balanceOf(payee), 100e8);
        (, , , , uint64 nextAfter, , uint32 runsAfter, bool stillActive,) = vault.schedules(id);
        assertEq(runsAfter, 2);
        assertTrue(stillActive);
        assertEq(nextAfter, uint64(block.timestamp + 1 hours));
        assertEq(vault.reserved(), 150e8);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.NotDue.selector, id, nextAfter));
        vault.executeSchedule(id);
        assertEq(token.balanceOf(payee), 100e8);
    }

    function test_schedule_agentCannotReserveAboveDaily() public {
        vm.prank(agent);
        vm.expectRevert();
        vault.createSchedule(agent, payee, 150e8, 1 hours, 3, bytes32(0));
        vm.prank(agent);
        uint256 id = vault.createSchedule(agent, payee, 100e8, 1 hours, 4, bytes32(0));
        assertEq(id, 1);
        assertEq(vault.reserved(), 400e8);
    }

    function test_intent_relayerAndReplay() public {
        AgentVault.PaymentIntent memory intent = AgentVault.PaymentIntent({
            agent: agent,
            payee: payee,
            amount: 40e8,
            memo: bytes32("relay"),
            nonce: 0,
            deadline: block.timestamp + 1 days
        });
        bytes32 digest = vault.hashIntent(intent);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(stranger);
        vault.executeIntent(intent, sig);
        assertEq(token.balanceOf(payee), 40e8);
        assertEq(vault.nonces(agent), 1);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.BadNonce.selector, 1, 0));
        vault.executeIntent(intent, sig);
    }

    function test_routerBatch() public {
        PaymentRouter router = new PaymentRouter();
        AgentVault.PaymentIntent[] memory intents = new AgentVault.PaymentIntent[](2);
        bytes[] memory sigs = new bytes[](2);
        intents[0] = AgentVault.PaymentIntent(agent, payee, 10e8, bytes32("a"), 0, block.timestamp + 1 days);
        intents[1] = AgentVault.PaymentIntent(agent, payee, 15e8, bytes32("b"), 1, block.timestamp + 1 days);
        for (uint256 i; i < 2; i++) {
            bytes32 digest = vault.hashIntent(intents[i]);
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, digest);
            sigs[i] = abi.encodePacked(r, s, v);
        }
        router.executeBatch(vault, intents, sigs);
        assertEq(token.balanceOf(payee), 25e8);
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
        amounts[0] = 100e8;
        amounts[1] = 80e8;
        vm.prank(agent);
        vault.batchPay(payees, amounts, memos);
        assertEq(token.balanceOf(payee), 100e8);
        assertEq(token.balanceOf(second), 80e8);
        assertEq(vault.spentInWindow(agent), 180e8);
    }

    function test_escrowFundViaVault() public {
        escrow = new InvoiceEscrow(token, owner, owner);
        vm.prank(owner);
        vault.setEscrow(address(escrow));
        vm.prank(payee);
        uint256 id = escrow.createInvoice(address(vault), 90e8, uint64(block.timestamp + 2 days), keccak256("INV-0142"));
        vm.prank(agent);
        vault.fundInvoice(id);
        assertEq(token.balanceOf(address(escrow)), 90e8);
        assertEq(vault.spentInWindow(agent), 90e8);

        vm.prank(payee);
        escrow.markDelivered(id);
        vm.prank(owner);
        vault.confirmInvoice(id);
        assertEq(token.balanceOf(payee), 90e8);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_reentrancy_onPay_reverts() public {
        ReenteringToken bad = new ReenteringToken();
        EcdsaAgentAuth auth2 = new EcdsaAgentAuth();
        AgentVault v2 = new AgentVault(IERC20(address(bad)), owner, auth2);
        bad.setVault(v2);
        bad.mint(owner, 1_000e8);
        vm.startPrank(owner);
        bad.approve(address(v2), type(uint256).max);
        v2.deposit(500e8);
        v2.registerAgent(agent, 100e8, 100e8, 0, true);
        vm.stopPrank();
        vm.prank(agent);
        vm.expectRevert();
        v2.pay(payee, 10e8, bytes32(0));
        assertEq(bad.balanceOf(payee), 0);
    }

    function testFuzz_perTxAndDaily(uint128 perTx, uint128 daily, uint256 amount) public {
        perTx = uint128(bound(perTx, 1, 500e8));
        daily = uint128(bound(daily, perTx, 1_000e8));
        amount = bound(amount, 1, 2_000e8);
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
        daily = uint128(bound(daily, 1, 2_000e8));
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
}
