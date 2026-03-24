// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";

/// @title Methodology Registry — On-Chain Carbon Offset Methodology Governance
/// @notice Maintains the canonical list of approved carbon credit methodologies
///         that national registries may use when minting CRS credits.
///         Governance (multi-sig or DAO) approves or revokes methodology standards
///         such as REDD+ ART-TREES, Verra VM0015, Gold Standard LUF, etc.
///
///         This closes the governance gap vs Regen Network — instead of trusting
///         off-chain issuers to apply valid methodologies, the approved set is
///         published on-chain and enforced at mint time by SovereignRegistry.
///
///         Integration: SovereignRegistry holds an optional reference to this
///         contract. If configured, mintCredit and mintBatch reject any credit
///         whose methodology string is not in the approved set.
contract MethodologyRegistry is AccessControl {

    // ─────────────────────────────────────────────────────
    //  ERRORS
    // ─────────────────────────────────────────────────────

    error InvalidAdmin();
    /// @param key keccak256(abi.encodePacked(methodology)) that was not found
    error MethodologyNotFound(bytes32 key);
    /// @param key keccak256(abi.encodePacked(methodology)) that already exists
    error MethodologyAlreadyApproved(bytes32 key);
    error EmptyMethodologyName();

    // ─────────────────────────────────────────────────────
    //  ROLES
    // ─────────────────────────────────────────────────────

    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    bytes32 public constant ADMIN_ROLE      = keccak256("ADMIN_ROLE");

    // ─────────────────────────────────────────────────────
    //  STORAGE
    // ─────────────────────────────────────────────────────

    /// @dev Key = keccak256(abi.encodePacked(methodologyName))
    ///      Value = true if the methodology is currently approved
    mapping(bytes32 => bool) public approved;

    /// @dev Human-readable name stored for event indexing and UI display.
    ///      Key = same keccak256 as above.
    mapping(bytes32 => string) public methodologyName;

    // ─────────────────────────────────────────────────────
    //  EVENTS
    // ─────────────────────────────────────────────────────

    event MethodologyApproved(bytes32 indexed key, string name);
    event MethodologyRevoked(bytes32 indexed key, string name);

    // ─────────────────────────────────────────────────────
    //  CONSTRUCTOR
    // ─────────────────────────────────────────────────────

    constructor(address admin) {
        if (admin == address(0)) revert InvalidAdmin();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
        _grantRole(GOVERNANCE_ROLE, admin);
    }

    // ─────────────────────────────────────────────────────
    //  GOVERNANCE
    // ─────────────────────────────────────────────────────

    /// @notice Approve a carbon offset methodology for use in CRS credits.
    /// @dev    Key is derived deterministically: keccak256(abi.encodePacked(name)).
    ///         Governance should use the full canonical methodology identifier,
    ///         e.g. "ART-TREES-v2.0", "VM0015-v1.3", "AR-ACM0003-v4.0".
    /// @param  name Canonical methodology identifier string.
    function approveMethodology(string calldata name) external onlyRole(GOVERNANCE_ROLE) {
        if (bytes(name).length == 0) revert EmptyMethodologyName();
        bytes32 key = keccak256(abi.encodePacked(name));
        if (approved[key]) revert MethodologyAlreadyApproved(key);
        approved[key]          = true;
        methodologyName[key]   = name;
        emit MethodologyApproved(key, name);
    }

    /// @notice Revoke an approved methodology.
    /// @dev    Existing credits minted under this methodology are NOT invalidated —
    ///         revocation only prevents NEW credits from referencing the methodology.
    ///         This mirrors how real-world methodology retirement works.
    /// @param  name Canonical methodology identifier string to revoke.
    function revokeMethodology(string calldata name) external onlyRole(GOVERNANCE_ROLE) {
        bytes32 key = keccak256(abi.encodePacked(name));
        if (!approved[key]) revert MethodologyNotFound(key);
        approved[key] = false;
        emit MethodologyRevoked(key, name);
    }

    // ─────────────────────────────────────────────────────
    //  VIEWS
    // ─────────────────────────────────────────────────────

    /// @notice Check if a methodology string is currently approved.
    /// @param  name Methodology string exactly as it appears on the credit.
    /// @return True if the methodology is approved for use in new credits.
    function isApproved(string calldata name) external view returns (bool) {
        return approved[keccak256(abi.encodePacked(name))];
    }

    /// @notice Derive the registry key for a methodology name — utility for off-chain callers.
    function getKey(string calldata name) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(name));
    }
}
