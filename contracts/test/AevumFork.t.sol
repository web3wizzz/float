// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SdkConfig} from "../script/SdkConfig.sol";

interface IDecimals {
    function decimals() external view returns (uint8);
}

/// @notice Confirms the real tUSD8 on Aevum. Skipped unless AEVUM_FORK=true.
///         forge test --match-contract AevumForkTest
///         The rpc alias `aevum` is contracts/foundry.toml.
contract AevumForkTest is Test {
    function test_tusd8_isSixDecimals() public {
        if (!vm.envOr("AEVUM_FORK", false)) {
            vm.skip(true);
            return;
        }
        SdkConfig.Aevum memory cfg = SdkConfig.read();
        if (block.chainid != cfg.chainId) vm.createSelectFork("aevum");
        assertEq(block.chainid, cfg.chainId);
        assertEq(IDecimals(cfg.tusd8).decimals(), cfg.decimals);
    }
}
