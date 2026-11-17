// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Pluggable signature check for agent payment intents.
/// @dev ECDSA today. A post-quantum scheme replaces this contract, not AgentVault:
///      PQ signatures generally cannot recover an address, so `verify` takes the
///      claimed signer and checks the signature against a registered key.
interface IAgentAuth {
    /// @return ok True when `signature` authorizes `digest` for `claimedSigner`.
    function verify(address claimedSigner, bytes32 digest, bytes calldata signature) external view returns (bool ok);
}
