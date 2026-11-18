// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Foundry stand-in for Aevum tUSD8. `decimals()` is 6, matching the live
///         token, so a test amount written as `150e6` is 150 whole tokens.
///         The address and the canonical decimals live in packages/sdk/src/config.ts.
///         `SdkConfig.t.sol` checks this function against that file.
contract MockTUSD8 is ERC20 {
    constructor() ERC20("Aevum Test USD", "tUSD8") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
