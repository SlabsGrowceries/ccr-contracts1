// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IAllowlist.sol";

/// @dev Test-only allowlist. Not for production.
///      Allows specific addresses to be toggled on/off by any caller.
contract MockAllowlist is IAllowlist {
    mapping(address => bool) public allowed;

    function allow(address account) external { allowed[account] = true; }
    function block_(address account) external { allowed[account] = false; }
    function isAllowed(address account) external view returns (bool) { return allowed[account]; }
}
