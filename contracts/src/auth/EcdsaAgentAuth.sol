// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IAgentAuth} from "../interfaces/IAgentAuth.sol";

/// @title EcdsaAgentAuth
/// @notice Recovers an EIP-712 digest with OpenZeppelin's malleability-safe ECDSA.
///         Swap the vault's auth module for a PQ verifier without changing spend logic.
contract EcdsaAgentAuth is IAgentAuth {
    function verify(address claimedSigner, bytes32 digest, bytes calldata signature) external pure returns (bool ok) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        return err == ECDSA.RecoverError.NoError && recovered == claimedSigner && recovered != address(0);
    }
}
