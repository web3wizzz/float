// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Foundry stand-in for tUSD8. `decimals()` returns 8 so a test amount
///         written as `150e8` is 150 whole tokens in this suite.
///         The Aevum token's decimals are UNVERIFIED and are not stored here.
///         Read them only from packages/sdk/src/config.ts.
contract MockTUSD8 is ERC20 {
    constructor() ERC20("Aevum Test USD", "tUSD8") {}

    function decimals() public pure override returns (uint8) {
        return 8;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
