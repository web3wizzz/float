// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {AgentVault} from "../src/AgentVault.sol";
import {InvoiceEscrow} from "../src/InvoiceEscrow.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";
import {EcdsaAgentAuth} from "../src/auth/EcdsaAgentAuth.sol";
import {MockTUSD8} from "../src/mocks/MockTUSD8.sol";
import {DeployPlan, SdkConfig} from "./SdkConfig.sol";

/// @notice Deploys auth, vault, escrow, and router. Writes deployments/latest.json.
///         On the chain id from packages/sdk/src/config.ts (Aevum, 44005) this uses the
///         tUSD8 address in that file, checks decimals(), and will not deploy MockTUSD8.
///         DEPLOYER_PRIVATE_KEY defaults to Anvil account #0 for local runs only.
contract Deploy is Script {
    // well-known Anvil #0 — local demos only, never a funded key
    uint256 internal constant ANVIL_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function run() external {
        uint256 pk = vm.envOr("DEPLOYER_PRIVATE_KEY", ANVIL_KEY);
        address owner = vm.envOr("OWNER_ADDRESS", vm.addr(pk));
        address envToken = vm.envOr("TUSD8_ADDRESS", address(0));
        address arbiter = vm.envOr("ARBITER_ADDRESS", owner);

        SdkConfig.Aevum memory cfg = SdkConfig.read();
        (address tokenAddr, bool mock) = DeployPlan.choose(block.chainid, cfg.chainId, envToken, cfg.tusd8);
        // Belt and braces: the Aevum path never deploys a stand-in token.
        if (block.chainid == cfg.chainId && mock) revert DeployPlan.RefusingMockOnAevum();

        uint8 dec = cfg.decimals;
        if (!mock) {
            dec = IERC20Metadata(tokenAddr).decimals();
            if (dec != cfg.decimals) revert DeployPlan.UnexpectedDecimals(dec, cfg.decimals);
        }

        vm.startBroadcast(pk);
        if (mock) {
            if (block.chainid == cfg.chainId) revert DeployPlan.RefusingMockOnAevum();
            tokenAddr = address(new MockTUSD8());
        }
        EcdsaAgentAuth auth = new EcdsaAgentAuth();
        AgentVault vault = new AgentVault(IERC20(tokenAddr), owner, auth);
        InvoiceEscrow escrow = new InvoiceEscrow(IERC20(tokenAddr), owner, arbiter);
        vault.setEscrow(address(escrow));
        PaymentRouter router = new PaymentRouter();
        vm.stopBroadcast();

        string memory obj = "deploy";
        vm.serializeAddress(obj, "token", tokenAddr);
        vm.serializeAddress(obj, "auth", address(auth));
        vm.serializeAddress(obj, "vault", address(vault));
        vm.serializeAddress(obj, "escrow", address(escrow));
        vm.serializeAddress(obj, "router", address(router));
        vm.serializeAddress(obj, "owner", owner);
        vm.serializeBool(obj, "mockToken", mock);
        vm.serializeUint(obj, "decimals", dec);
        string memory json = vm.serializeUint(obj, "chainId", block.chainid);
        vm.writeJson(json, "deployments/latest.json");
    }
}
