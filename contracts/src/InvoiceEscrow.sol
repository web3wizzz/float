// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {InvoiceTypes} from "./libraries/InvoiceTypes.sol";

/// @title InvoiceEscrow
/// @notice Payee opens an invoice. Payer (a wallet or an AgentVault) funds it.
///         Delivery + payer confirm releases funds. Past due without delivery refunds.
///         Delivery cannot be marked at or after the due date, so a late mark cannot
///         block that refund or mature into an auto-release.
///         After a delivery that landed in time, anyone can release once the confirm window elapses.
///         Either party can flag a dispute; only the arbiter can resolve it.
contract InvoiceEscrow is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    uint64 public constant CONFIRM_WINDOW = 3 days;

    IERC20 public immutable token;
    address public arbiter;
    uint256 public invoiceCount;

    mapping(uint256 id => InvoiceTypes.Invoice) public invoices;

    event InvoiceCreated(
        uint256 indexed id,
        address indexed payee,
        address indexed payer,
        uint256 amount,
        uint64 dueDate,
        bytes32 metadataHash
    );
    event InvoiceFunded(uint256 indexed id, address indexed from);
    event InvoiceDelivered(uint256 indexed id);
    event InvoiceReleased(uint256 indexed id, address indexed to, uint256 amount);
    event InvoiceRefunded(uint256 indexed id, address indexed to, uint256 amount);
    event InvoiceDisputed(uint256 indexed id, address indexed by);
    event ArbiterUpdated(address indexed arbiter);

    error ZeroAddress();
    error ZeroAmount();
    error DueDateInPast();
    error BadStatus();
    error NotPayer();
    error NotPayee();
    error NotParty();
    error NotArbiter();
    error TooEarly();
    error DueDatePassed(uint256 id);
    error UnknownInvoice();

    constructor(IERC20 paymentToken, address initialOwner, address initialArbiter) Ownable(initialOwner) {
        if (address(paymentToken) == address(0) || initialArbiter == address(0)) revert ZeroAddress();
        token = paymentToken;
        arbiter = initialArbiter;
    }

    function setArbiter(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        arbiter = next;
        emit ArbiterUpdated(next);
    }

    function createInvoice(address payer, uint256 amount, uint64 dueDate, bytes32 metadataHash)
        external
        returns (uint256 id)
    {
        if (payer == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (dueDate <= block.timestamp) revert DueDateInPast();
        id = ++invoiceCount;
        invoices[id] = InvoiceTypes.Invoice({
            payee: msg.sender,
            payer: payer,
            amount: amount,
            dueDate: dueDate,
            fundedAt: 0,
            deliveredAt: 0,
            metadataHash: metadataHash,
            status: InvoiceTypes.Status.Open
        });
        emit InvoiceCreated(id, msg.sender, payer, amount, dueDate, metadataHash);
    }

    function fund(uint256 id) external nonReentrant {
        InvoiceTypes.Invoice storage inv = invoices[id];
        if (inv.status == InvoiceTypes.Status.None) revert UnknownInvoice();
        if (inv.status != InvoiceTypes.Status.Open) revert BadStatus();
        if (msg.sender != inv.payer) revert NotPayer();
        if (block.timestamp >= inv.dueDate) revert DueDatePassed(id);
        inv.status = InvoiceTypes.Status.Funded;
        inv.fundedAt = uint64(block.timestamp);
        token.safeTransferFrom(msg.sender, address(this), inv.amount);
        emit InvoiceFunded(id, msg.sender);
    }

    function markDelivered(uint256 id) external {
        InvoiceTypes.Invoice storage inv = invoices[id];
        if (inv.payee != msg.sender) revert NotPayee();
        if (inv.status != InvoiceTypes.Status.Funded) revert BadStatus();
        if (block.timestamp >= inv.dueDate) revert DueDatePassed(id);
        inv.status = InvoiceTypes.Status.Delivered;
        inv.deliveredAt = uint64(block.timestamp);
        emit InvoiceDelivered(id);
    }

    function confirm(uint256 id) external nonReentrant {
        InvoiceTypes.Invoice storage inv = invoices[id];
        if (msg.sender != inv.payer) revert NotPayer();
        if (inv.status != InvoiceTypes.Status.Delivered) revert BadStatus();
        _release(inv, id);
    }

    function autoRelease(uint256 id) external nonReentrant {
        InvoiceTypes.Invoice storage inv = invoices[id];
        if (inv.status != InvoiceTypes.Status.Delivered) revert BadStatus();
        if (block.timestamp < uint256(inv.deliveredAt) + CONFIRM_WINDOW) revert TooEarly();
        _release(inv, id);
    }

    function refund(uint256 id) external nonReentrant {
        InvoiceTypes.Invoice storage inv = invoices[id];
        if (inv.status != InvoiceTypes.Status.Funded) revert BadStatus();
        if (block.timestamp < inv.dueDate) revert TooEarly();
        inv.status = InvoiceTypes.Status.Refunded;
        token.safeTransfer(inv.payer, inv.amount);
        emit InvoiceRefunded(id, inv.payer, inv.amount);
    }

    function dispute(uint256 id) external {
        InvoiceTypes.Invoice storage inv = invoices[id];
        if (msg.sender != inv.payer && msg.sender != inv.payee) revert NotParty();
        if (inv.status != InvoiceTypes.Status.Funded && inv.status != InvoiceTypes.Status.Delivered) {
            revert BadStatus();
        }
        inv.status = InvoiceTypes.Status.Disputed;
        emit InvoiceDisputed(id, msg.sender);
    }

    function resolve(uint256 id, bool releaseToPayee) external nonReentrant {
        if (msg.sender != arbiter) revert NotArbiter();
        InvoiceTypes.Invoice storage inv = invoices[id];
        if (inv.status != InvoiceTypes.Status.Disputed) revert BadStatus();
        if (releaseToPayee) {
            _release(inv, id);
        } else {
            inv.status = InvoiceTypes.Status.Refunded;
            token.safeTransfer(inv.payer, inv.amount);
            emit InvoiceRefunded(id, inv.payer, inv.amount);
        }
    }

    function _release(InvoiceTypes.Invoice storage inv, uint256 id) internal {
        uint256 amount = inv.amount;
        address to = inv.payee;
        inv.status = InvoiceTypes.Status.Released;
        token.safeTransfer(to, amount);
        emit InvoiceReleased(id, to, amount);
    }
}
