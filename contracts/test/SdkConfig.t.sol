// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployPlan, SdkConfig} from "../script/SdkConfig.sol";
import {MockTUSD8} from "../src/mocks/MockTUSD8.sol";

contract SdkConfigTest is Test {
    function test_readsSdkConfigAndMockMatches() public {
        SdkConfig.Aevum memory cfg = SdkConfig.read();
        assertEq(cfg.chainId, 44005);
        assertEq(cfg.decimals, 6);
        assertTrue(cfg.tusd8 != address(0));
        assertEq(new MockTUSD8().decimals(), cfg.decimals);
    }

    function test_aevumNeverSelectsMock() public {
        SdkConfig.Aevum memory cfg = SdkConfig.read();

        (address token, bool deployMock) = DeployPlan.choose(cfg.chainId, cfg.chainId, address(0), cfg.tusd8);
        assertFalse(deployMock);
        assertEq(token, cfg.tusd8);

        (token, deployMock) = DeployPlan.choose(cfg.chainId, cfg.chainId, cfg.tusd8, cfg.tusd8);
        assertFalse(deployMock);
        assertEq(token, cfg.tusd8);

        vm.expectRevert(abi.encodeWithSelector(DeployPlan.UnexpectedTusd8.selector, address(0xBEEF), cfg.tusd8));
        DeployPlan.choose(cfg.chainId, cfg.chainId, address(0xBEEF), cfg.tusd8);

        vm.expectRevert(DeployPlan.RefusingMockOnAevum.selector);
        DeployPlan.choose(cfg.chainId, cfg.chainId, address(0), address(0));
    }

    function test_otherChainsCanDeployMock() public view {
        SdkConfig.Aevum memory cfg = SdkConfig.read();
        (address token, bool deployMock) = DeployPlan.choose(31337, cfg.chainId, address(0), cfg.tusd8);
        assertTrue(deployMock);
        assertEq(token, address(0));

        (token, deployMock) = DeployPlan.choose(31337, cfg.chainId, address(0xBEEF), cfg.tusd8);
        assertFalse(deployMock);
        assertEq(token, address(0xBEEF));
    }
}
