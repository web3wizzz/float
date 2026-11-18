// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";

/// @notice Deploy-time view of `packages/sdk/src/config.ts`.
///         Chain id, the tUSD8 address, and decimals are parsed from that file.
///         Do not copy them into Solidity.
library SdkConfig {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    struct Aevum {
        uint256 chainId;
        address tusd8;
        uint8 decimals;
    }

    error MissingKey(string key);
    error BadAddress();

    function read() internal view returns (Aevum memory cfg) {
        string memory path = string.concat(vm.projectRoot(), "/../packages/sdk/src/config.ts");
        string memory config = vm.readFile(path);
        cfg.chainId = _parseUint(config, "export const chainId = ");
        cfg.decimals = uint8(_parseUint(config, "export const tusd8Decimals = "));
        cfg.tusd8 = _parseAddress(config, 'export const tusd8 = "');
    }

    function _parseUint(string memory config, string memory key) private pure returns (uint256) {
        bytes memory rest = _after(config, key);
        uint256 n;
        bool any;
        for (uint256 i; i < rest.length; ++i) {
            bytes1 c = rest[i];
            if (c < "0" || c > "9") break;
            any = true;
            n = n * 10 + uint256(uint8(c) - 48);
        }
        if (!any) revert MissingKey(key);
        return n;
    }

    function _parseAddress(string memory config, string memory key) private pure returns (address) {
        bytes memory rest = _after(config, key);
        if (rest.length < 42 || rest[0] != "0" || rest[1] != "x") revert BadAddress();
        uint160 acc;
        for (uint256 i = 2; i < 42; ++i) {
            acc = (acc << 4) | _hex(rest[i]);
        }
        if (acc == 0) revert BadAddress();
        return address(acc);
    }

    function _hex(bytes1 c) private pure returns (uint8) {
        if (c >= "0" && c <= "9") return uint8(c) - 48;
        if (c >= "a" && c <= "f") return uint8(c) - 87;
        if (c >= "A" && c <= "F") return uint8(c) - 55;
        revert BadAddress();
    }

    function _after(string memory config, string memory key) private pure returns (bytes memory) {
        bytes memory haystack = bytes(config);
        bytes memory needle = bytes(key);
        if (needle.length == 0 || haystack.length < needle.length) revert MissingKey(key);
        for (uint256 i; i + needle.length <= haystack.length; ++i) {
            bool found = true;
            for (uint256 j; j < needle.length; ++j) {
                if (haystack[i + j] != needle[j]) {
                    found = false;
                    break;
                }
            }
            if (!found) continue;
            uint256 start = i + needle.length;
            bytes memory rest = new bytes(haystack.length - start);
            for (uint256 k; k < rest.length; ++k) {
                rest[k] = haystack[start + k];
            }
            return rest;
        }
        revert MissingKey(key);
    }
}

/// @notice Pure token selection so the Aevum path can be tested without a broadcast.
library DeployPlan {
    error RefusingMockOnAevum();
    error UnexpectedTusd8(address given, address expected);
    error UnexpectedDecimals(uint8 got, uint8 expected);

    /// @return token Token to wire. The zero address means the caller deploys MockTUSD8.
    /// @return deployMock True only off Aevum, and only when no token address was provided.
    function choose(uint256 chainId, uint256 aevumChainId, address envToken, address canonical)
        public
        pure
        returns (address token, bool deployMock)
    {
        if (chainId == aevumChainId) {
            if (canonical == address(0)) revert RefusingMockOnAevum();
            if (envToken != address(0) && envToken != canonical) revert UnexpectedTusd8(envToken, canonical);
            return (canonical, false);
        }
        if (envToken == address(0)) return (address(0), true);
        return (envToken, false);
    }
}
