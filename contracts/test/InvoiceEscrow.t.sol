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
        assertEq(token.decimals(), 6);
        escrow = new InvoiceEscrow(token, payer, arbiter);
        token.mint(payer, 1_000e6);
        vm.prank(payer);
        token.approve(address(escrow), type(uint256).max);
    }

    function _open(uint256 amount) internal returns (uint256 id) {
        vm.prank(payee);
        id = escrow.createInvoice(payer, amount, uint64(block.timestamp + 1 days), keccak256("meta"));
    }

    function test_happyPath() public {
        uint256 id = _open(80e6);
        vm.prank(payer);
        escrow.fund(id);
        assertEq(token.balanceOf(address(escrow)), 80e6);
        vm.prank(payee);
        escrow.markDelivered(id);
        vm.prank(payer);
        escrow.confirm(id);
        assertEq(token.balanceOf(payee), 80e6);
        assertEq(token.balanceOf(address(escrow)), 0);
        (,,,,,,, InvoiceTypes.Status status) = escrow.invoices(id);
        assertEq(uint256(status), uint256(InvoiceTypes.Status.Released));
    }

    function test_refundAfterDueWithoutDelivery() public {
        uint256 id = _open(40e6);
        vm.prank(payer);
        escrow.fund(id);
        vm.prank(payer);
        vm.expectRevert(InvoiceEscrow.TooEarly.selector);
        escrow.refund(id);
        vm.warp(block.timestamp + 1 days);
        escrow.refund(id);
        assertEq(token.balanceOf(payer), 1_000e6);
    }

    function test_autoReleaseAfterConfirmWindow() public {
        uint256 id = _open(25e6);
        vm.prank(payer);
        escrow.fund(id);
        vm.prank(payee);
        escrow.markDelivered(id);
        vm.expectRevert(InvoiceEscrow.TooEarly.selector);
        escrow.autoRelease(id);
        vm.warp(block.timestamp + 3 days);
        escrow.autoRelease(id);
        assertEq(token.balanceOf(payee), 25e6);
    }

    function test_disputeResolvedByArbiter() public {
        uint256 id = _open(30e6);
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
        assertEq(token.balanceOf(payer), 1_000e6);

        uint256 id2 = _open(11e6);
        vm.prank(payer);
        escrow.fund(id2);
        vm.prank(payee);
        escrow.dispute(id2);
        vm.prank(arbiter);
        escrow.resolve(id2, true);
        assertEq(token.balanceOf(payee), 11e6);
    }

    function test_nonPayerCannotFund() public {
        uint256 id = _open(5e6);
        vm.prank(payee);
        vm.expectRevert(InvoiceEscrow.NotPayer.selector);
        escrow.fund(id);
    }

    function testFuzz_fundMatchesBalance(uint96 raw) public {
        uint256 amount = bound(uint256(raw), 1, 500e6);
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

    function test_lateDeliveryCannotBlockRefund() public {
        uint256 id = _open(40e6);
        vm.prank(payer);
        escrow.fund(id);
        vm.warp(block.timestamp + 1 days);
        vm.prank(payee);
        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrow.DueDatePassed.selector, id));
        escrow.markDelivered(id);
        escrow.refund(id);
        assertEq(token.balanceOf(payer), 1_000e6);
        assertEq(token.balanceOf(payee), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_fundAfterDueReverts() public {
        uint256 id = _open(5e6);
        vm.warp(block.timestamp + 1 days);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrow.DueDatePassed.selector, id));
        escrow.fund(id);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function testFuzz_noDeliveryAfterDue(uint96 raw, uint32 extra) public {
        uint256 amount = bound(uint256(raw), 1, 400e6);
        uint256 id = _open(amount);
        vm.prank(payer);
        escrow.fund(id);
        vm.warp(block.timestamp + 1 days + bound(uint256(extra), 0, 10 days));
        vm.prank(payee);
        vm.expectRevert(abi.encodeWithSelector(InvoiceEscrow.DueDatePassed.selector, id));
        escrow.markDelivered(id);
        uint256 payerBefore = token.balanceOf(payer);
        escrow.refund(id);
        assertEq(token.balanceOf(payer), payerBefore + amount);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(token.balanceOf(payee), 0);
    }

    function testFuzz_cannotReleaseTwice(uint96 raw, uint8 path) public {
        uint256 amount = bound(uint256(raw), 1, 500e6);
        uint256 id = _open(amount);
        vm.prank(payer);
        escrow.fund(id);
        vm.prank(payee);
        escrow.markDelivered(id);
        if (path % 2 == 0) {
            vm.prank(payer);
            escrow.confirm(id);
        } else {
            vm.warp(block.timestamp + 3 days);
            escrow.autoRelease(id);
        }
        vm.prank(payer);
        vm.expectRevert(InvoiceEscrow.BadStatus.selector);
        escrow.confirm(id);
        vm.expectRevert(InvoiceEscrow.BadStatus.selector);
        escrow.autoRelease(id);
        assertEq(token.balanceOf(payee), amount);
        assertEq(token.balanceOf(address(escrow)), 0);
    }
}
