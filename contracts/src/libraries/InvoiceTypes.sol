// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library InvoiceTypes {
    enum Status {
        None,
        Open,
        Funded,
        Delivered,
        Disputed,
        Released,
        Refunded
    }

    struct Invoice {
        address payee;
        address payer;
        uint256 amount;
        uint64 dueDate;
        uint64 fundedAt;
        uint64 deliveredAt;
        bytes32 metadataHash;
        Status status;
    }
}
