// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";

/// @title RetirementVault
/// @notice Immutable global ledger recording all carbon credit retirements by nation
/// @dev Append-only design ensures permanent, tamper-proof audit trail
contract RetirementVault is AccessControl {
    bytes32 public constant REGISTRY_ROLE = keccak256("REGISTRY_ROLE");

    mapping(bytes32 => bool) private _recorded;

    struct RetirementRecord {
        uint256 tokenId;
        bytes2 nationCode;
        string purpose;
        uint256 retiredAt;
    }

    /// @notice Emitted when a credit retirement is recorded in the vault
    event CreditRetiredGlobal(bytes32 indexed key, uint256 indexed tokenId, bytes2 indexed nationCode);

    /// @notice Initialize the vault with an admin
    /// @param admin Address to receive DEFAULT_ADMIN_ROLE
    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Record a credit retirement permanently in the vault
    /// @param r Retirement record containing token ID, nation code, purpose, and timestamp
    function recordRetirement(RetirementRecord calldata r) external onlyRole(REGISTRY_ROLE) {
        require(r.tokenId > 0, "INVALID_TOKEN_ID");
        require(bytes(r.purpose).length > 0, "PURPOSE_REQUIRED");
        require(r.retiredAt > 0, "INVALID_TIMESTAMP");

        bytes32 key = keccak256(abi.encodePacked(r.tokenId, r.nationCode));
        require(!_recorded[key], "ALREADY_RECORDED");

        _recorded[key] = true;

        emit CreditRetiredGlobal(key, r.tokenId, r.nationCode);
    }

    /// @notice Check if a retirement has been recorded for a given token and nation
    /// @param tokenId The credit token ID
    /// @param nationCode The nation code
    /// @return True if the retirement has been recorded
    function isRecorded(uint256 tokenId, bytes2 nationCode) external view returns (bool) {
        bytes32 key = keccak256(abi.encodePacked(tokenId, nationCode));
        return _recorded[key];
    }

    /// @notice Grant REGISTRY_ROLE to a registry contract
    /// @param registry The registry contract address
    function addRegistry(address registry) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(REGISTRY_ROLE, registry);
    }
}