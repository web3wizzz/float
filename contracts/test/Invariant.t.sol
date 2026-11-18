// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdAssertions} from "forge-std/StdAssertions.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {AgentVault} from "../src/AgentVault.sol";
import {EcdsaAgentAuth} from "../src/auth/EcdsaAgentAuth.sol";
import {MockTUSD8} from "../src/mocks/MockTUSD8.sol";
import {InvoiceEscrow} from "../src/InvoiceEscrow.sol";
import {InvoiceTypes} from "../src/libraries/InvoiceTypes.sol";

/// @dev Owner, agent, and attacker. The fuzzer only enters through these functions.
contract VaultHandler is StdUtils, StdAssertions {
    Vm internal constant cheat = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant AGENT_PK = 0xA11CE;
    uint256 internal constant ATTACKER_PK = 0xBEEF;

    AgentVault public vault;
    MockTUSD8 public token;
    address public owner = address(0x1111);
    address public agent;
    address public attacker;
    address public payee = address(0xBEEF);

    uint256 public ghostVault;
    uint256 public illegalSpends;
    uint256 public replaysAccepted;
    mapping(uint256 id => uint256 count) public executions;

    constructor() {
        agent = cheat.addr(AGENT_PK);
        attacker = cheat.addr(ATTACKER_PK);
        token = new MockTUSD8();
        assertEq(token.decimals(), 6);
        cheat.warp(1_700_000_000);
        vault = new AgentVault(token, owner, new EcdsaAgentAuth());
        token.mint(owner, 5_000_000e6);
        cheat.startPrank(owner);
        token.approve(address(vault), type(uint256).max);
        vault.deposit(1_000_000e6);
        vault.registerAgent(agent, 2_000e6, 8_000e6, 0, false);
        vault.setPayee(agent, payee, true);
        cheat.stopPrank();
        ghostVault = 1_000_000e6;
    }

    function pay(uint256 amount, uint256 payeeSeed, bool asAttacker) external {
        amount = bound(amount, 0, 30_000e6);
        address to = _payee(payeeSeed);
        address caller = asAttacker ? attacker : agent;
        uint256 vaultBefore = token.balanceOf(address(vault));
        uint256 toBefore = token.balanceOf(to);
        uint256 reservedBefore = vault.reserved();
        cheat.prank(caller);
        try vault.pay(to, amount, bytes32("pay")) {
            _assertSpend(caller, to, amount, vaultBefore, toBefore, reservedBefore, false);
        } catch {
            _unchanged(vaultBefore, to, toBefore, reservedBefore);
        }
        _checkpoint();
    }

    function deposit(uint256 amount) external {
        uint256 bal = token.balanceOf(owner);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        uint256 before = token.balanceOf(address(vault));
        cheat.prank(owner);
        try vault.deposit(amount) {
            ghostVault += amount;
            assertEq(token.balanceOf(address(vault)), before + amount);
        } catch {
            assertEq(token.balanceOf(address(vault)), before);
        }
        _checkpoint();
    }

    function withdraw(uint256 amount) external {
        uint256 bal = token.balanceOf(address(vault));
        uint256 reservedBefore = vault.reserved();
        uint256 ownerBefore = token.balanceOf(owner);
        amount = bound(amount, 0, bal + 1);
        cheat.prank(owner);
        try vault.withdraw(amount) {
            assertGt(amount, 0);
            assertLe(amount, bal - reservedBefore);
            ghostVault -= amount;
            assertEq(token.balanceOf(address(vault)), bal - amount);
            assertEq(token.balanceOf(owner), ownerBefore + amount);
            assertEq(vault.reserved(), reservedBefore);
        } catch {
            assertEq(token.balanceOf(address(vault)), bal);
            assertEq(token.balanceOf(owner), ownerBefore);
        }
        _checkpoint();
    }

    function attackerWithdraw(uint256 amount) external {
        uint256 bal = token.balanceOf(address(vault));
        cheat.prank(attacker);
        try vault.withdraw(amount) {
            illegalSpends += 1;
        } catch {}
        assertEq(illegalSpends, 0);
        assertEq(token.balanceOf(address(vault)), bal);
        _checkpoint();
    }

    function warp(uint256 hoursAhead) external {
        hoursAhead = bound(hoursAhead, 0, 96);
        cheat.warp(block.timestamp + hoursAhead * 1 hours);
    }

    function setAgentPaused(bool paused) external {
        cheat.prank(owner);
        try vault.setAgentPaused(agent, paused) {} catch {}
        _checkpoint();
    }

    function setGlobalPaused(bool paused) external {
        cheat.prank(owner);
        vault.setGlobalPaused(paused);
        _checkpoint();
    }

    function revokeOrReregister(uint128 perTx, uint128 daily, bool allowAny, bool revokeFirst) external {
        perTx = uint128(bound(perTx, 1, 5_000e6));
        daily = uint128(bound(daily, perTx, 20_000e6));
        if (revokeFirst) {
            cheat.prank(owner);
            try vault.revokeAgent(agent) {} catch {}
        }
        cheat.prank(owner);
        try vault.registerAgent(agent, perTx, daily, 0, allowAny) {
            if (!allowAny) {
                cheat.prank(owner);
                vault.setPayee(agent, payee, true);
            }
        } catch {}
        _checkpoint();
    }

    function setPayeeAllowed(uint256 payeeSeed, bool allowed) external {
        address who = _payee(payeeSeed);
        cheat.prank(owner);
        try vault.setPayee(agent, who, allowed) {} catch {}
        _checkpoint();
    }

    function openSchedule(uint128 amount, uint8 runs, bool asAgent, uint256 lateHours) external {
        amount = uint128(bound(amount, 1, 5_000e6));
        uint32 maxRuns = uint32(bound(runs, 1, 6));
        uint256 reservedBefore = vault.reserved();
        uint256 agentResBefore = vault.agentReserved(agent);
        uint256 countBefore = vault.scheduleCount();
        cheat.prank(asAgent ? agent : owner);
        try vault.createSchedule(agent, payee, amount, 1 hours, maxRuns, bytes32("sch")) returns (uint256 id) {
            uint256 obligation = uint256(amount) * maxRuns;
            assertEq(vault.reserved(), reservedBefore + obligation);
            if (asAgent) {
                assertLe(agentResBefore + obligation, _daily());
                assertEq(vault.agentReserved(agent), agentResBefore + obligation);
                assertTrue(vault.scheduleFromAgent(id));
                assertFalse(vault.globalPaused());
                (,, uint64 expiry,, bool paused, bool active) = vault.policies(agent);
                assertTrue(active);
                assertFalse(paused);
                assertTrue(expiry == 0 || block.timestamp <= expiry);
            } else {
                assertEq(vault.agentReserved(agent), agentResBefore);
                assertFalse(vault.scheduleFromAgent(id));
            }
            if (lateHours % 2 == 0) {
                cheat.warp(block.timestamp + bound(lateHours, 0, 72) * 1 hours);
                _execute(id);
            }
        } catch {
            assertEq(vault.scheduleCount(), countBefore);
            assertEq(vault.reserved(), reservedBefore);
            assertEq(vault.agentReserved(agent), agentResBefore);
        }
        _checkpoint();
    }

    function runSchedule(uint256 idSeed, uint256 lateHours) external {
        uint256 n = vault.scheduleCount();
        if (n == 0) return;
        cheat.warp(block.timestamp + bound(lateHours, 0, 72) * 1 hours);
        _execute(1 + (idSeed % n));
        _checkpoint();
    }

    function cancel(uint256 idSeed) external {
        uint256 n = vault.scheduleCount();
        if (n == 0) return;
        uint256 id = 1 + (idSeed % n);
        (address schedAgent,, uint128 amount,,, uint32 maxRuns, uint32 runs, bool active,) = vault.schedules(id);
        uint256 reservedBefore = vault.reserved();
        uint256 agentResBefore = vault.agentReserved(schedAgent);
        bool fromAgent = vault.scheduleFromAgent(id);
        uint256 remaining = active ? uint256(amount) * uint256(maxRuns - runs) : 0;
        address caller = idSeed % 3 == 0 ? owner : idSeed % 3 == 1 ? schedAgent : attacker;
        cheat.prank(caller);
        try vault.cancelSchedule(id) {
            assertTrue(active);
            assertTrue(caller == owner || caller == schedAgent);
            assertEq(vault.reserved(), reservedBefore - remaining);
            if (fromAgent) assertEq(vault.agentReserved(schedAgent), agentResBefore - remaining);
            else assertEq(vault.agentReserved(schedAgent), agentResBefore);
            (,,,,,,, bool still,) = vault.schedules(id);
            assertFalse(still);
        } catch {
            assertEq(vault.reserved(), reservedBefore);
            assertEq(vault.agentReserved(schedAgent), agentResBefore);
        }
        _checkpoint();
    }

    function submitIntent(uint96 rawAmount, uint8 mode) external {
        uint256 amount = bound(rawAmount, 1, 5_000e6);
        uint8 kind = mode % 5;
        uint256 nonce = vault.nonces(agent);
        AgentVault.PaymentIntent memory intent = AgentVault.PaymentIntent({
            agent: agent,
            payee: payee,
            amount: amount,
            memo: bytes32("intent"),
            nonce: nonce,
            deadline: kind == 3 ? block.timestamp - 1 : block.timestamp + 2 days
        });
        bytes32 digest = vault.hashIntent(intent);
        (uint8 v, bytes32 r, bytes32 s) = cheat.sign(kind == 4 ? ATTACKER_PK : AGENT_PK, digest);
        bytes memory sig = abi.encodePacked(r, s, v);
        if (kind == 1) intent.amount = amount + 1;

        uint256 vaultBefore = token.balanceOf(address(vault));
        uint256 payeeBefore = token.balanceOf(payee);
        uint256 reservedBefore = vault.reserved();
        bool mustFail = kind == 1 || kind == 3 || kind == 4;
        cheat.prank(attacker);
        try vault.executeIntent(intent, sig) {
            if (mustFail) illegalSpends += 1;
            assertEq(illegalSpends, 0);
            _assertSpend(agent, payee, amount, vaultBefore, payeeBefore, reservedBefore, false);
            assertEq(vault.nonces(agent), nonce + 1);
            try vault.executeIntent(intent, sig) {
                replaysAccepted += 1;
            } catch {}
            assertEq(replaysAccepted, 0);
            assertEq(vault.nonces(agent), nonce + 1);
        } catch {
            assertEq(vault.nonces(agent), nonce);
            _unchanged(vaultBefore, payee, payeeBefore, reservedBefore);
        }
        _checkpoint();
    }

    function reservedFromSchedules() public view returns (uint256 sum) {
        uint256 n = vault.scheduleCount();
        for (uint256 i = 1; i <= n; ++i) {
            (,, uint128 amount,,, uint32 maxRuns, uint32 runs, bool active,) = vault.schedules(i);
            if (active) sum += uint256(amount) * uint256(maxRuns - runs);
        }
    }

    function agentReservedFromSchedules() public view returns (uint256 sum) {
        uint256 n = vault.scheduleCount();
        for (uint256 i = 1; i <= n; ++i) {
            (address schedAgent,, uint128 amount,,, uint32 maxRuns, uint32 runs, bool active,) = vault.schedules(i);
            if (active && vault.scheduleFromAgent(i) && schedAgent == agent) {
                sum += uint256(amount) * uint256(maxRuns - runs);
            }
        }
    }

    function _execute(uint256 id) internal {
        (,, uint128 amount,,, uint32 maxRuns, uint32 runsBefore, bool active,) = vault.schedules(id);
        if (!active || runsBefore >= maxRuns) return;
        uint256 payeeBefore = token.balanceOf(payee);
        uint256 vaultBefore = token.balanceOf(address(vault));
        uint256 reservedBefore = vault.reserved();
        try vault.executeSchedule(id) {
            assertEq(token.balanceOf(payee), payeeBefore + uint256(amount));
            assertEq(token.balanceOf(address(vault)), vaultBefore - uint256(amount));
            assertEq(vault.reserved(), reservedBefore - uint256(amount));
            (,,,,,, uint32 runsAfter, bool activeAfter,) = vault.schedules(id);
            assertEq(uint256(runsAfter), uint256(runsBefore) + 1);
            assertEq(activeAfter, runsAfter < maxRuns);
            executions[id] += 1;
            ghostVault -= uint256(amount);
            try vault.executeSchedule(id) {
                illegalSpends += 1;
            } catch {}
            assertEq(illegalSpends, 0);
            assertEq(token.balanceOf(payee), payeeBefore + uint256(amount));
        } catch {
            _unchanged(vaultBefore, payee, payeeBefore, reservedBefore);
        }
    }

    function _assertSpend(
        address caller,
        address to,
        uint256 amount,
        uint256 vaultBefore,
        uint256 toBefore,
        uint256 reservedBefore,
        bool fromReserve
    ) internal {
        (uint128 perTx, uint128 daily, uint64 expiry, bool allowAny, bool paused, bool active) = vault.policies(caller);
        assertFalse(vault.globalPaused());
        assertTrue(active);
        assertFalse(paused);
        assertTrue(expiry == 0 || block.timestamp <= expiry);
        assertGt(amount, 0);
        assertLe(amount, perTx);
        assertLe(vault.spentInWindow(caller), daily);
        if (!allowAny) assertTrue(vault.allowedPayee(caller, to));
        assertEq(token.balanceOf(address(vault)), vaultBefore - amount);
        assertEq(token.balanceOf(to), toBefore + amount);
        if (fromReserve) assertEq(vault.reserved(), reservedBefore - amount);
        else assertEq(vault.reserved(), reservedBefore);
        ghostVault -= amount;
    }

    function _unchanged(uint256 vaultBefore, address to, uint256 toBefore, uint256 reservedBefore) internal view {
        assertEq(token.balanceOf(address(vault)), vaultBefore);
        assertEq(token.balanceOf(to), toBefore);
        assertEq(vault.reserved(), reservedBefore);
    }

    function _checkpoint() internal view {
        assertEq(token.balanceOf(address(vault)), ghostVault);
    }

    function _daily() internal view returns (uint256 daily) {
        (, daily,,,,) = vault.policies(agent);
    }

    function _payee(uint256 seed) internal view returns (address who) {
        who = address(uint160(bound(seed, 1, type(uint160).max - 1)));
        if (who == address(vault) || who == address(token) || who == address(this)) who = payee;
    }
}

/// forge-config: default.invariant.fail_on_revert = true
/// forge-config: default.invariant.runs = 40
/// forge-config: default.invariant.depth = 20
contract AgentVaultInvariantTest is Test {
    VaultHandler internal h;

    function setUp() public {
        h = new VaultHandler();
        targetContract(address(h));
        bytes4[] memory selectors = new bytes4[](13);
        selectors[0] = VaultHandler.pay.selector;
        selectors[1] = VaultHandler.deposit.selector;
        selectors[2] = VaultHandler.withdraw.selector;
        selectors[3] = VaultHandler.attackerWithdraw.selector;
        selectors[4] = VaultHandler.warp.selector;
        selectors[5] = VaultHandler.setAgentPaused.selector;
        selectors[6] = VaultHandler.setGlobalPaused.selector;
        selectors[7] = VaultHandler.revokeOrReregister.selector;
        selectors[8] = VaultHandler.setPayeeAllowed.selector;
        selectors[9] = VaultHandler.openSchedule.selector;
        selectors[10] = VaultHandler.runSchedule.selector;
        selectors[11] = VaultHandler.cancel.selector;
        selectors[12] = VaultHandler.submitIntent.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: selectors}));
    }

    function invariant_vaultCoversReserve() public view {
        assertGe(h.token().balanceOf(address(h.vault())), h.vault().reserved());
    }

    function invariant_vaultBalanceMatchesGhost() public view {
        assertEq(h.token().balanceOf(address(h.vault())), h.ghostVault());
    }

    function invariant_reserveMatchesSchedules() public view {
        assertEq(h.vault().reserved(), h.reservedFromSchedules());
    }

    function invariant_agentReserveMatchesSchedules() public view {
        assertEq(h.vault().agentReserved(h.agent()), h.agentReservedFromSchedules());
    }

    function invariant_scheduleChargedOncePerRun() public view {
        uint256 n = h.vault().scheduleCount();
        for (uint256 i = 1; i <= n; ++i) {
            (,,,,,, uint32 runs,,) = h.vault().schedules(i);
            assertEq(h.executions(i), uint256(runs));
        }
    }

    function invariant_noIllegalSpendOrReplay() public view {
        assertEq(h.illegalSpends(), 0);
        assertEq(h.replaysAccepted(), 0);
    }
}

/// @dev Payer, payee, and arbiter. Token conservation is recomputed from invoice status.
contract EscrowHandler is StdUtils, StdAssertions {
    Vm internal constant cheat = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    InvoiceEscrow public escrow;
    MockTUSD8 public token;
    address public payer = address(0x1111);
    address public payee = address(0x2222);
    address public arbiter = address(0x3333);

    constructor() {
        cheat.warp(1_700_000_000);
        token = new MockTUSD8();
        assertEq(token.decimals(), 6);
        escrow = new InvoiceEscrow(token, payer, arbiter);
        token.mint(payer, 2_000_000e6);
        cheat.prank(payer);
        token.approve(address(escrow), type(uint256).max);
    }

    function createAndFund(uint256 amount, uint256 dueIn) external {
        amount = bound(amount, 1, 50_000e6);
        uint64 due = uint64(block.timestamp + bound(dueIn, 1 hours, 20 days));
        cheat.prank(payee);
        try escrow.createInvoice(payer, amount, due, bytes32("m")) returns (uint256 id) {
            cheat.prank(payer);
            try escrow.fund(id) {} catch {}
        } catch {}
        _solvent();
    }

    function deliver(uint256 idSeed) external {
        _act(idSeed, 0);
    }

    function confirm(uint256 idSeed) external {
        _act(idSeed, 1);
    }

    function refund(uint256 idSeed) external {
        _act(idSeed, 2);
    }

    function autoRelease(uint256 idSeed) external {
        _act(idSeed, 3);
    }

    function dispute(uint256 idSeed, bool asPayee) external {
        uint256 id = _id(idSeed);
        if (id == 0) return;
        cheat.prank(asPayee ? payee : payer);
        try escrow.dispute(id) {} catch {}
        _solvent();
    }

    function resolve(uint256 idSeed, bool toPayee) external {
        uint256 id = _id(idSeed);
        if (id == 0) return;
        cheat.prank(arbiter);
        try escrow.resolve(id, toPayee) {} catch {}
        _solvent();
    }

    function warp(uint256 secondsAhead) external {
        secondsAhead = bound(secondsAhead, 0, 40 days);
        cheat.warp(block.timestamp + secondsAhead);
    }

    function locked() public view returns (uint256 sum) {
        uint256 n = escrow.invoiceCount();
        for (uint256 i = 1; i <= n; ++i) {
            (,, uint256 amount,,,,, InvoiceTypes.Status status) = escrow.invoices(i);
            if (
                status == InvoiceTypes.Status.Funded || status == InvoiceTypes.Status.Delivered
                    || status == InvoiceTypes.Status.Disputed
            ) sum += amount;
        }
    }

    function _act(uint256 idSeed, uint8 kind) internal {
        uint256 id = _id(idSeed);
        if (id == 0) return;
        if (kind == 0) {
            cheat.prank(payee);
            try escrow.markDelivered(id) {} catch {}
        } else if (kind == 1) {
            cheat.prank(payer);
            try escrow.confirm(id) {} catch {}
        } else if (kind == 2) {
            try escrow.refund(id) {} catch {}
        } else {
            try escrow.autoRelease(id) {} catch {}
        }
        _solvent();
    }

    function _id(uint256 idSeed) internal view returns (uint256) {
        uint256 n = escrow.invoiceCount();
        if (n == 0) return 0;
        return 1 + (idSeed % n);
    }

    function _solvent() internal view {
        assertEq(token.balanceOf(address(escrow)), locked());
    }
}

/// forge-config: default.invariant.fail_on_revert = true
/// forge-config: default.invariant.runs = 40
/// forge-config: default.invariant.depth = 20
contract InvoiceEscrowInvariantTest is Test {
    EscrowHandler internal h;

    function setUp() public {
        h = new EscrowHandler();
        targetContract(address(h));
        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = EscrowHandler.createAndFund.selector;
        selectors[1] = EscrowHandler.deliver.selector;
        selectors[2] = EscrowHandler.confirm.selector;
        selectors[3] = EscrowHandler.refund.selector;
        selectors[4] = EscrowHandler.autoRelease.selector;
        selectors[5] = EscrowHandler.dispute.selector;
        selectors[6] = EscrowHandler.resolve.selector;
        selectors[7] = EscrowHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: selectors}));
    }

    /// @dev Every funded, delivered, or disputed invoice is still backed by tokens.
    ///      Released and refunded invoices are not. A second payout would break this.
    function invariant_escrowSolvent() public view {
        assertEq(h.token().balanceOf(address(h.escrow())), h.locked());
    }
}
