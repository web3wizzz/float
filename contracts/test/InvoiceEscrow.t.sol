// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {InvoiceEscrow} from "../src/InvoiceEscrow.sol";
import {InvoiceTypes} from "../src/libraries/InvoiceTypes.sol";
import {MockTUSD8} from "../src/mocks/MockTUSD8.sol";

contract InvoiceEscrowTest is Test {
    MockTUSD8 internal token;
    InvoiceEscrow internal escrow;
    address internal payer;
    address internal payee;
    address internal arbiter;

    function setUp() public {
        vm.warp(1_700_000_000);
        payer = makeAddr("payer");
        payee = makeAddr("payee");
        arbiter = makeAddr("arbiter");
        token = new MockTUSD8();
        escrow = new InvoiceEscrow(token, payer, arbiter);
        token.mint(payer, 1_000e8);
        vm.prank(payer);
        token.approve(address(escrow), type(uint256).max);
    }

    function _open(uint256 amount) internal returns (uint256 id) {
        vm.prank(payee);
        id = escrow.createInvoice(payer, amount, uint64(block.timestamp + 1 days), keccak256("meta"));
    }

    function test_happyPath() public {
        uint256 id = _open(80e8);
        vm.prank(payer);
        escrow.fund(id);
        assertEq(token.balanceOf(address(escrow)), 80e8);
        vm.prank(payee);
        escrow.markDelivered(id);
        vm.prank(payer);
        escrow.confirm(id);
        assertEq(token.balanceOf(payee), 80e8);
        assertEq(token.balanceOf(address(escrow)), 0);
        (,,,,,,, InvoiceTypes.Status status) = escrow.invoices(id);
        assertEq(uint256(status), uint256(InvoiceTypes.Status.Released));
    }

    function test_refundAfterDueWithoutDelivery() public {
        uint256 id = _open(40e8);
        vm.prank(payer);
        escrow.fund(id);
        vm.prank(payer);
        vm.expectRevert(InvoiceEscrow.TooEarly.selector);
        escrow.refund(id);
        vm.warp(block.timestamp + 1 days);
        escrow.refund(id);
        assertEq(token.balanceOf(payer), 1_000e8);
    }

    function test_autoReleaseAfterConfirmWindow() public {
        uint256 id = _open(25e8);
        vm.prank(payer);
        escrow.fund(id);
        vm.prank(payee);
        escrow.markDelivered(id);
        vm.expectRevert(InvoiceEscrow.TooEarly.selector);
        escrow.autoRelease(id);
        vm.warp(block.timestamp + 3 days);
        escrow.autoRelease(id);
        assertEq(token.balanceOf(payee), 25e8);
    }

    function test_disputeResolvedByArbiter() public {
        uint256 id = _open(30e8);
        vm.prank(payer);
        escrow.fund(id);
        vm.prank(payee);
        escrow.markDelivered(id);
        vm.prank(payer);
        escrow.dispute(id);
        vm.prank(payer);
        vm.expectRevert(InvoiceEscrow.BadStatus.selector);
        escrow.confirm(id);
        vm.prank(makeAddr("nope"));
        vm.expectRevert(InvoiceEscrow.NotArbiter.selector);
        escrow.resolve(id, false);
        vm.prank(arbiter);
        escrow.resolve(id, false);
        assertEq(token.balanceOf(payer), 1_000e8);

        uint256 id2 = _open(11e8);
        vm.prank(payer);
        escrow.fund(id2);
        vm.prank(payee);
        escrow.dispute(id2);
        vm.prank(arbiter);
        escrow.resolve(id2, true);
        assertEq(token.balanceOf(payee), 11e8);
    }

    function test_nonPayerCannotFund() public {
        uint256 id = _open(5e8);
        vm.prank(payee);
        vm.expectRevert(InvoiceEscrow.NotPayer.selector);
        escrow.fund(id);
    }

    function testFuzz_fundMatchesBalance(uint96 raw) public {
        uint256 amount = bound(uint256(raw), 1, 500e8);
        uint256 id = _open(amount);
        uint256 before = token.balanceOf(payer);
        vm.prank(payer);
        escrow.fund(id);
        assertEq(token.balanceOf(address(escrow)), amount);
        assertEq(token.balanceOf(payer), before - amount);
        vm.prank(payee);
        escrow.markDelivered(id);
        vm.prank(payer);
        escrow.confirm(id);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(token.balanceOf(payee), amount);
    }
}
