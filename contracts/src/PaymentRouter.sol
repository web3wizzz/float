// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentVault} from "./AgentVault.sol";

/// @title PaymentRouter
/// @notice Relayer entrypoint: submit a bounded batch of EIP-712 payment intents.
///         The vault still enforces policy, nonce, and deadline on every item.
///         This is not a custody contract and holds no tokens.
contract PaymentRouter {
    uint256 public constant MAX_BATCH = 8;

    error BadBatch();

    function executeBatch(
        AgentVault vault,
        AgentVault.PaymentIntent[] calldata intents,
        bytes[] calldata signatures
    ) external {
        uint256 n = intents.length;
        if (n == 0 || n > MAX_BATCH || signatures.length != n) revert BadBatch();
        for (uint256 i; i < n;) {
            vault.executeIntent(intents[i], signatures[i]);
            unchecked {
                ++i;
            }
        }
    }
}
