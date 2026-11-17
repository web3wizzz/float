// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {AgentVault} from "../src/AgentVault.sol";
import {EcdsaAgentAuth} from "../src/auth/EcdsaAgentAuth.sol";
import {MockTUSD8} from "../src/mocks/MockTUSD8.sol";
import {InvoiceEscrow} from "../src/InvoiceEscrow.sol";
import {InvoiceTypes} from "../src/libraries/InvoiceTypes.sol";

/// @dev Narrow surface so the invariant fuzzer only hits these entrypoints.
contract VaultHandler {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    AgentVault public vault;
    MockTUSD8 public token;
    address public owner;
    address public agent;
    address public payee;

    constructor() {
        owner = address(0xA11CE);
        agent = address(0xA6E17);
        payee = address(0xBEEF);
        token = new MockTUSD8();
        vm.warp(1_700_000_000);
        vault = new AgentVault(token, owner, new EcdsaAgentAuth());
        token.mint(owner, 1e30);
        vm.startPrank(owner);
        token.approve(address(vault), type(uint256).max);
        vault.deposit(1e24);
        vault.registerAgent(agent, 1e18, 1e20, 0, true);
        vm.stopPrank();
    }

    function pay(uint256 amount) external {
        amount = _bound(amount, 0, 2e18);
        vm.prank(agent);
        try vault.pay(payee, amount, bytes32("pay")) {} catch {}
    }

    function warpHours(uint256 hoursAhead) external {
        hoursAhead = _bound(hoursAhead, 0, 48);
        vm.warp(block.timestamp + hoursAhead * 1 hours);
    }

    function withdraw(uint256 amount) external {
        amount = _bound(amount, 0, 1e24);
        vm.prank(owner);
        try vault.withdraw(amount) {} catch {}
    }

    function deposit(uint256 amount) external {
        amount = _bound(amount, 1, 1e21);
        vm.prank(owner);
        try vault.deposit(amount) {} catch {}
    }

    function openAndMaybeExecute(uint128 amount, uint32 runs) external {
        amount = uint128(_bound(amount, 1, 1e18));
        runs = uint32(_bound(runs, 1, 4));
        vm.prank(owner);
        try vault.createSchedule(agent, payee, amount, 1 hours, runs, bytes32("sch")) returns (uint256 id) {
            try vault.executeSchedule(id) {} catch {}
        } catch {}
    }

    function _bound(uint256 x, uint256 min, uint256 max) internal pure returns (uint256) {
        if (max <= min) return min;
        return min + (x % (max - min + 1));
    }
}

contract AgentVaultInvariantTest is Test {
    VaultHandler internal h;

    function setUp() public {
        h = new VaultHandler();
        targetContract(address(h));
    }

    function invariant_vaultCoversReserve() public view {
        assertGe(h.token().balanceOf(address(h.vault())), h.vault().reserved());
    }

    function invariant_spentWithinDaily() public view {
        (uint128 perTx, uint128 daily,,,,) = h.vault().policies(h.agent());
        perTx;
        assertLe(h.vault().spentInWindow(h.agent()), daily);
    }
}

contract EscrowHandler {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    InvoiceEscrow public escrow;
    MockTUSD8 public token;
    address public payer;
    address public payee;
    address public arbiter;
    uint256 public ghostLocked;

    constructor() {
        vm.warp(1_700_000_000);
        payer = address(0x1111);
        payee = address(0x2222);
        arbiter = address(0x3333);
        token = new MockTUSD8();
        escrow = new InvoiceEscrow(token, payer, arbiter);
        token.mint(payer, 1e30);
        vm.prank(payer);
        token.approve(address(escrow), type(uint256).max);
    }

    function createAndFund(uint256 amount) external {
        amount = _bound(amount, 1, 1e20);
        vm.prank(payee);
        uint256 id = escrow.createInvoice(payer, amount, uint64(block.timestamp + 3 days), bytes32("m"));
        vm.prank(payer);
        escrow.fund(id);
        ghostLocked += amount;
    }

    function deliverAndConfirm(uint256 rawId) external {
        uint256 n = escrow.invoiceCount();
        if (n == 0) return;
        uint256 id = 1 + (rawId % n);
        (,,,,,,, InvoiceTypes.Status status) = escrow.invoices(id);
        if (status != InvoiceTypes.Status.Funded) return;
        vm.prank(payee);
        escrow.markDelivered(id);
        vm.prank(payer);
        escrow.confirm(id);
        (, , uint256 amount,,,,,) = escrow.invoices(id);
        ghostLocked -= amount;
    }

    function _bound(uint256 x, uint256 min, uint256 max) internal pure returns (uint256) {
        if (max <= min) return min;
        return min + (x % (max - min + 1));
    }
}

contract InvoiceEscrowInvariantTest is Test {
    EscrowHandler internal h;

    function setUp() public {
        h = new EscrowHandler();
        targetContract(address(h));
    }

    function invariant_escrowCoversOpenInvoices() public view {
        assertGe(h.token().balanceOf(address(h.escrow())), h.ghostLocked());
    }
}
