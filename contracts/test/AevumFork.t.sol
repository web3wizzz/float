// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

interface IDecimals {
    function decimals() external view returns (uint8);
}

/// @notice Confirms the real tUSD8 on Aevum. Skipped unless AEVUM_FORK=true.
///         forge test --match-contract AevumForkTest
///         The rpc alias `aevum` is contracts/foundry.toml.
contract AevumForkTest is Test {
    address internal constant TUSD8 = 0x456569838f1d43009A91ebA4263147Afd7233483;

    function test_tusd8_isSixDecimals() public {
        if (!vm.envOr("AEVUM_FORK", false)) {
            vm.skip(true);
            return;
        }
        if (block.chainid != 44005) vm.createSelectFork("aevum");
        assertEq(block.chainid, 44005);
        assertEq(IDecimals(TUSD8).decimals(), 6);
    }
}
