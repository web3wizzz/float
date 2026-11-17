// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {InvoiceTypes} from "../libraries/InvoiceTypes.sol";

interface IInvoiceEscrow {
    function invoices(uint256 id)
        external
        view
        returns (
            address payee,
            address payer,
            uint256 amount,
            uint64 dueDate,
            uint64 fundedAt,
            uint64 deliveredAt,
            bytes32 metadataHash,
            InvoiceTypes.Status status
        );

    function fund(uint256 id) external;
    function confirm(uint256 id) external;
    function refund(uint256 id) external;
    function dispute(uint256 id) external;
}
