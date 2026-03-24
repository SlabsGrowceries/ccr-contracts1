// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";

/// @title MRVOracle
/// @notice Multi-signature attestation oracle for verifying carbon credit monitoring, reporting, and verification (MRV) data.
/// @dev Uses threshold-based multi-sig consensus. Requires minimum number of auditor signatures to finalize attestations.
contract MRVOracle is AccessControl {
    bytes32 public constant AUDITOR_ROLE = keccak256("AUDITOR_ROLE");

    uint256 public threshold;
    mapping(bytes32 => Attestation) public attestations;
    mapping(bytes32 => mapping(address => bool)) private _signed;

    struct Attestation {
        bytes32 satelliteHash;
        bytes32 geojsonHash;
        uint256 timestamp;
        address[] auditors;
        uint256 signatureCount;
        bool finalized;
    }

    /// @notice Emitted when an auditor submits a signature for an attestation
    event AuditorSigned(bytes32 indexed attestationId, address indexed auditor, bytes32 indexed geojsonHash);
    
    /// @notice Emitted when an attestation reaches the required signature threshold and is finalized
    event AttestationFinalized(bytes32 indexed attestationId);

    /// @notice Initialize the oracle with a minimum signature threshold
    /// @param _threshold Minimum number of auditor signatures required (must be >= 3)
    constructor(uint256 _threshold) {
        require(_threshold >= 3, "THRESHOLD_TOO_LOW");
        threshold = _threshold;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    /// @notice Add a new auditor with AUDITOR_ROLE permissions
    /// @param auditor The address of the auditor to add
    function addAuditor(address auditor) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(auditor != address(0), "INVALID_AUDITOR");
        if (_auditorRegistered[auditor]) return;
        _auditorRegistered[auditor] = true;
        _grantRole(AUDITOR_ROLE, auditor);
    }

    /// @notice Update the minimum signature threshold required for attestation finalization
    /// @param _threshold New threshold value (must be >= 3)
    function setThreshold(uint256 _threshold) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_threshold >= 3, "THRESHOLD_TOO_LOW");
        threshold = _threshold;
    }

    /// @notice Submit an attestation signature from an auditor
    /// @param satelliteHash Hash of satellite imagery data
    /// @param geojsonHash Hash of parcel GeoJSON geometry
    function submitAttestation(bytes32 satelliteHash, bytes32 geojsonHash) external onlyRole(AUDITOR_ROLE) {
        require(satelliteHash != bytes32(0), "INVALID_SATELLITE_HASH");
        bytes32 attestationId = getAttestationId(satelliteHash);
        Attestation storage a = attestations[attestationId];
        require(!_signed[attestationId][msg.sender], "ALREADY_SIGNED");

        if (a.signatureCount == 0) {
            a.satelliteHash = satelliteHash;
            a.geojsonHash = geojsonHash;
            a.timestamp = block.timestamp;
        } else {
            require(a.geojsonHash == geojsonHash, "HASH_MISMATCH: auditors disagree");
        }

        _signed[attestationId][msg.sender] = true;
        a.auditors.push(msg.sender);
        a.signatureCount++;

        emit AuditorSigned(attestationId, msg.sender, geojsonHash);

        if (a.signatureCount >= threshold && !a.finalized) {
            a.finalized = true;
            emit AttestationFinalized(attestationId);
        }
    }

    /// @notice Derive a deterministic attestation ID from satellite hash
    /// @param satelliteHash The satellite imagery hash
    /// @return The derived attestation ID
    function getAttestationId(bytes32 satelliteHash) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(satelliteHash));
    }

    /// @notice Check if an attestation has been finalized by sufficient auditor signatures
    /// @param attestationId The attestation ID to check
    /// @return True if attestation has reached threshold and is finalized
    function isFinalized(bytes32 attestationId) external view returns (bool) {
        return attestations[attestationId].finalized;
    }

    /// @notice Remove an auditor and revoke AUDITOR_ROLE permissions
    /// @param auditor The address of the auditor to remove
    function removeAuditor(address auditor) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(AUDITOR_ROLE, auditor);
        _auditorRegistered[auditor] = false;
    }

    mapping(address => bool) private _auditorRegistered; // for idempotency
}