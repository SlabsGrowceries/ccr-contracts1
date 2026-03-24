// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "./CRSToken.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/// @title MRV Oracle — Measurement, Reporting, Verification
/// @notice Aggregates independent auditor attestations via threshold multi-sig.
///         A credit cannot be minted until at least 3-of-5 accredited auditors
///         have signed the same satellite data, report, and parcel boundary.
contract MRVOracle is AccessControl {

    // ─────────────────────────────────────────────────────
    //  ERRORS
    // ─────────────────────────────────────────────────────

    error InvalidAdmin();
    error InvalidAuditor();
    error MaxAuditorsReached();
    error NotAnAuditor(address auditor);
    error WouldBreakThreshold();
    error ProposalPending();
    error ThresholdTooLow(uint8 requested);
    error ThresholdExceedsAuditors();
    error NoPendingUpdate();
    error TimelockNotExpired(uint64 validAfter);
    error InvalidSatelliteHash();
    error InvalidReportHash();
    error InvalidParcelHash();
    /// @param existing   compositeHash the first auditor committed to
    /// @param submitted  compositeHash the current auditor tried to commit
    error HashMismatch(bytes32 existing, bytes32 submitted);
    error AttestationAlreadyFinalized(bytes32 attestationId);
    error AlreadySigned(bytes32 attestationId, address auditor);
    /// @param attestationId ID of the attestation that was not found
    error AttestationNotFound(bytes32 attestationId);

    // ─────────────────────────────────────────────────────
    //  ROLES & CONSTANTS
    // ─────────────────────────────────────────────────────

    bytes32 public constant AUDITOR_ROLE = keccak256("AUDITOR_ROLE");
    bytes32 public constant ADMIN_ROLE   = keccak256("ADMIN_ROLE");

    /// @notice The absolute floor for the signing threshold — can never be lowered.
    uint8 public constant MIN_THRESHOLD = 3;

    uint256 public constant TIMELOCK_DELAY = 2 days;

    // ─────────────────────────────────────────────────────
    //  STATE
    // ─────────────────────────────────────────────────────

    uint8 public threshold;     // current required signatures (>= MIN_THRESHOLD)
    uint8 public totalAuditors; // count of addresses currently holding AUDITOR_ROLE

    // Pending timelocked threshold change — validAfter == 0 means no pending update
    uint8  public pendingThreshold;
    uint64 public pendingThresholdValidAfter;

    /// @dev O(1) duplicate-signature detection — avoids an O(n) loop over signers.
    mapping(bytes32 => mapping(address => bool)) private _signerStatus;

    // ─────────────────────────────────────────────────────
    //  ATTESTATION STORAGE
    // ─────────────────────────────────────────────────────

    struct Attestation {
        bytes32   compositeHash; // keccak256(satelliteHash, reportHash, parcelHash)
        address[] signers;       // auditors who have signed (ordered by submission time)
        bool      finalized;     // true once the threshold has been reached
        uint64    timestamp;     // block.timestamp when finalized
    }

    /// @dev Key = keccak256(satelliteHash, reportHash) — same derivation as verifyAttestation()
    mapping(bytes32 => Attestation) public attestations;

    // ─────────────────────────────────────────────────────
    //  EVENTS
    // ─────────────────────────────────────────────────────

    event AuditorSigned(bytes32 indexed attestationId, address indexed auditor, uint8 sigCount);
    event AttestationFinalized(bytes32 indexed attestationId, uint8 sigCount);
    event AuditorAdded(address indexed auditor);
    event AuditorRemoved(address indexed auditor);
    event ThresholdProposed(uint8 indexed newThreshold, uint64 validAfter);
    event ThresholdExecuted(uint8 oldThreshold, uint8 newThreshold);
    event ThresholdUpdateCancelled(uint8 indexed cancelledThreshold);
    event AttestationReset(bytes32 indexed attestationId, uint8 signersCleared);

    // ─────────────────────────────────────────────────────
    //  CONSTRUCTOR
    // ─────────────────────────────────────────────────────

    constructor(address admin, uint8 _threshold) {
        if (admin == address(0))        revert InvalidAdmin();
        if (_threshold < MIN_THRESHOLD) revert ThresholdTooLow(_threshold);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);

        threshold = _threshold;
    }

    // ─────────────────────────────────────────────────────
    //  AUDITOR MANAGEMENT
    // ─────────────────────────────────────────────────────

    /// @notice Add an accredited auditor (VVB) to the oracle pool.
    /// @dev    Idempotent — adding an existing auditor is a no-op (no counter inflation).
    /// @param  auditor Address of the accredited verification body to add.
    function addAuditor(address auditor) external onlyRole(ADMIN_ROLE) {
        if (auditor == address(0))          revert InvalidAuditor();
        if (totalAuditors == type(uint8).max) revert MaxAuditorsReached();
        // _grantRole returns true only if the role was NOT already held
        if (_grantRole(AUDITOR_ROLE, auditor)) {
            unchecked { totalAuditors++; }
            emit AuditorAdded(auditor);
        }
    }

    /// @notice Remove an auditor from the pool.
    /// @dev    Reverts if removal would reduce the live pool below the current threshold.
    /// @param  auditor Address of the auditor to remove.
    function removeAuditor(address auditor) external onlyRole(ADMIN_ROLE) {
        if (!hasRole(AUDITOR_ROLE, auditor)) revert NotAnAuditor(auditor);
        if (totalAuditors <= threshold)      revert WouldBreakThreshold();
        _revokeRole(AUDITOR_ROLE, auditor);
        unchecked { totalAuditors--; }
        emit AuditorRemoved(auditor);
    }

    // ─────────────────────────────────────────────────────
    //  THRESHOLD MANAGEMENT
    // ─────────────────────────────────────────────────────

    /// @notice Propose a new signing threshold — takes effect after TIMELOCK_DELAY.
    ///         Prevents a single compromised admin key from instantly weakening the oracle.
    /// @param  _threshold New threshold value; must be >= MIN_THRESHOLD and <= totalAuditors.
    function proposeThreshold(uint8 _threshold) external onlyRole(ADMIN_ROLE) {
        if (pendingThresholdValidAfter != 0)  revert ProposalPending();
        if (_threshold < MIN_THRESHOLD)       revert ThresholdTooLow(_threshold);
        if (_threshold > totalAuditors)       revert ThresholdExceedsAuditors();
        pendingThreshold = _threshold;
        pendingThresholdValidAfter = uint64(block.timestamp + TIMELOCK_DELAY);
        emit ThresholdProposed(_threshold, pendingThresholdValidAfter);
    }

    /// @notice Execute a proposed threshold change after the timelock expires.
    ///         Re-validates auditor count in case auditors were removed since proposal.
    function executeThreshold() external onlyRole(ADMIN_ROLE) {
        if (pendingThresholdValidAfter == 0)              revert NoPendingUpdate();
        if (block.timestamp < pendingThresholdValidAfter) revert TimelockNotExpired(pendingThresholdValidAfter);
        if (pendingThreshold > totalAuditors)             revert ThresholdExceedsAuditors();
        uint8 old = threshold;
        threshold  = pendingThreshold;
        pendingThreshold = 0;
        pendingThresholdValidAfter = 0;
        emit ThresholdExecuted(old, threshold);
    }

    /// @notice Cancel a pending threshold proposal before it executes.
    function cancelThreshold() external onlyRole(ADMIN_ROLE) {
        if (pendingThresholdValidAfter == 0) revert NoPendingUpdate();
        uint8 cancelled = pendingThreshold;
        pendingThreshold = 0;
        pendingThresholdValidAfter = 0;
        emit ThresholdUpdateCancelled(cancelled);
    }

    // ─────────────────────────────────────────────────────
    //  ATTESTATION
    // ─────────────────────────────────────────────────────

    /// @notice Auditor submits their signature for an MRV verification event.
    /// @dev    The attestation ID is derived deterministically from the inputs,
    ///         guaranteeing that verifyAttestation() will always resolve the same record.
    ///         All auditors must agree on the same composite hash — any disagreement
    ///         (different parcel boundary, different report) reverts with HashMismatch.
    /// @param  satelliteHash  keccak256 of the satellite imagery file
    /// @param  reportHash     keccak256 of the auditor verification report PDF
    /// @param  parcelHash     keccak256 of the GeoJSON parcel boundary
    /// @return attestationId  Deterministic ID under which this attestation is stored
    function submitAttestation(
        bytes32 satelliteHash,
        bytes32 reportHash,
        bytes32 parcelHash
    ) external onlyRole(AUDITOR_ROLE) returns (bytes32 attestationId) {
        if (satelliteHash == bytes32(0)) revert InvalidSatelliteHash();
        if (reportHash    == bytes32(0)) revert InvalidReportHash();
        if (parcelHash    == bytes32(0)) revert InvalidParcelHash();

        // Deterministic key — same derivation used by verifyAttestation()
        attestationId = keccak256(abi.encodePacked(satelliteHash, reportHash));

        Attestation storage a = attestations[attestationId];

        // Reject immediately if already finalized — before any hash comparison
        if (a.finalized) revert AttestationAlreadyFinalized(attestationId);

        // Composite hash binds all three evidence pieces — all auditors must agree
        bytes32 compositeHash = keccak256(abi.encodePacked(satelliteHash, reportHash, parcelHash));

        if (a.compositeHash == bytes32(0)) {
            a.compositeHash = compositeHash;
        } else if (a.compositeHash != compositeHash) {
            revert HashMismatch(a.compositeHash, compositeHash);
        }

        if (_signerStatus[attestationId][msg.sender]) revert AlreadySigned(attestationId, msg.sender);

        _signerStatus[attestationId][msg.sender] = true;
        a.signers.push(msg.sender);

        uint8 count = uint8(a.signers.length);
        emit AuditorSigned(attestationId, msg.sender, count);

        if (count >= threshold) {
            a.finalized  = true;
            a.timestamp  = uint64(block.timestamp);
            emit AttestationFinalized(attestationId, count);
        }
    }

    /// @notice Reset a poisoned or incorrectly started attestation so auditors can start fresh.
    /// @dev    Only callable on UNFINALIZED attestations — a finalized attestation is permanent.
    ///         Use case: auditor #1 submits a wrong parcel hash, locking all other auditors out
    ///         with HashMismatch. Admin resets the attestation; auditors resubmit correctly.
    ///         All signer status flags are cleared to prevent double-count on resubmission.
    ///         Uses ADMIN_ROLE (same as auditor management) — not DEFAULT_ADMIN_ROLE, which is
    ///         reserved for role management and should not double as an operations key.
    /// @param  attestationId The ID of the attestation to reset.
    function resetAttestation(bytes32 attestationId) external onlyRole(ADMIN_ROLE) {
        Attestation storage a = attestations[attestationId];
        if (a.compositeHash == bytes32(0))  revert AttestationNotFound(attestationId);
        if (a.finalized)                    revert AttestationAlreadyFinalized(attestationId);

        // Clean up per-signer status to prevent stale flags on resubmission
        address[] memory signers = a.signers;
        uint8 cleared = uint8(signers.length);
        unchecked {
            for (uint256 i = 0; i < signers.length; i++) {
                delete _signerStatus[attestationId][signers[i]];
            }
        }

        delete attestations[attestationId];
        emit AttestationReset(attestationId, cleared);
    }

    // ─────────────────────────────────────────────────────
    //  VERIFICATION
    // ─────────────────────────────────────────────────────

    /// @notice Called by SovereignRegistry to confirm an attestation is finalized and valid.
    ///         Verifies that parcelHash matches exactly what auditors committed to —
    ///         preventing a credit from being minted with a fraudulent parcel boundary.
    /// @param  att        The MRVAttestation struct from the credit being minted
    /// @param  parcelHash keccak256 of the GeoJSON parcel boundary on the credit
    /// @dev    Third parameter (proof) is reserved for ZK proof integration in Phase 2.
    /// @return            True iff the attestation is finalized and the parcel hash matches
    function verifyAttestation(
        MRVAttestation calldata att,
        bytes32 parcelHash,
        bytes calldata /* proof */
    ) external view returns (bool) {
        bytes32 id = keccak256(abi.encodePacked(att.satelliteHash, att.reportHash));
        Attestation storage a = attestations[id];
        if (!a.finalized) return false;
        bytes32 expected = keccak256(abi.encodePacked(att.satelliteHash, att.reportHash, parcelHash));
        return a.compositeHash == expected;
    }

    // ─────────────────────────────────────────────────────
    //  VIEWS
    // ─────────────────────────────────────────────────────

    /// @notice Check if an attestation has reached the signing threshold.
    function isFinalized(bytes32 attestationId) external view returns (bool) {
        return attestations[attestationId].finalized;
    }

    /// @notice Derive the attestation ID from its inputs — utility for off-chain callers.
    function getAttestationId(bytes32 satelliteHash, bytes32 reportHash)
        external pure returns (bytes32)
    {
        return keccak256(abi.encodePacked(satelliteHash, reportHash));
    }

    /// @notice Get the number of auditor signatures collected for an attestation.
    function sigCount(bytes32 attestationId) external view returns (uint256) {
        return attestations[attestationId].signers.length;
    }

    /// @notice Get the full list of auditor addresses that have signed an attestation.
    ///         Required because the auto-generated getter for `attestations` cannot
    ///         expose the dynamic signers array.
    function getSigners(bytes32 attestationId) external view returns (address[] memory) {
        return attestations[attestationId].signers;
    }
}
