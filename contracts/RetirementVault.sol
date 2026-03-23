// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "./CRSToken.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/// @title Retirement Vault — Immutable Global Offset Ledger
/// @notice Lives on the NCRI Hub chain. Records every retirement from every
///         national registry permanently. Cannot be deleted or modified.
///         Any third party (Norway's auditors, the UN, institutional buyers)
///         can verify an offset claim in real time without trusting CCR.
contract RetirementVault is AccessControl {

    // ─────────────────────────────────────────────────────
    //  ERRORS
    // ─────────────────────────────────────────────────────

    error InvalidAdmin();
    error InvalidRegistry();
    error InvalidNationCode();
    /// @param expected nationCode bound to the calling registry
    /// @param provided nationCode in the record submitted
    error WrongNation(bytes2 expected, bytes2 provided);
    error InvalidTokenId();
    error InvalidEntity();
    error InvalidTimestamp();
    error PurposeRequired();
    error SerialRequired();
    /// @param nationCode Nation code of the duplicate record
    /// @param tokenId    Token ID that has already been recorded
    error AlreadyRecorded(bytes2 nationCode, uint256 tokenId);
    /// @param index  Requested index
    /// @param length Current ledger length
    error IndexOutOfRange(uint256 index, uint256 length);

    // ─────────────────────────────────────────────────────
    //  ROLES
    // ─────────────────────────────────────────────────────

    bytes32 public constant REGISTRY_ROLE = keccak256("REGISTRY_ROLE");
    bytes32 public constant ADMIN_ROLE    = keccak256("ADMIN_ROLE");

    // ─────────────────────────────────────────────────────
    //  RETIREMENT RECORD
    // ─────────────────────────────────────────────────────

    struct RetirementRecord {
        uint256           tokenId;
        string            serialId;
        bytes2            nationCode;
        address           retiringEntity;
        string            entityName;
        CompliancePurpose purposeCode;    // compliance framework enum — drives stats mapping
        string            purpose;        // human-readable description (e.g. "CORSIA Q3 2032")
        string            complianceRef;  // specific reference (e.g. "Art6.2 NO-CD-2031")
        uint16            vintageYear;
        uint64            retiredAt;
        bytes32           attestationHash;
    }

    // ─────────────────────────────────────────────────────
    //  STORAGE
    // ─────────────────────────────────────────────────────

    RetirementRecord[] public ledger; // append-only — never delete or modify

    /// @dev Prevents double-retirement if a registry is compromised or has a bug.
    mapping(bytes2 => mapping(uint256 => bool)) private _alreadyRecorded;

    /// @dev Binds each registry address to the single nation it is authorised to record.
    ///      Set on addRegistry; prevents a compromised registry from poisoning other nations.
    mapping(address => bytes2) public registryNation;

    // Aggregate counters for compliance reporting.
    // @dev These count RETIREMENT EVENTS, not tonnes of CO2e retired.
    //      Each recordRetirement call increments all four counters by 1 regardless
    //      of the credit's tonneCO2e value. Consumers building tCO2e analytics must
    //      sum tonneCO2e from the RetirementRecord entries directly.
    mapping(bytes2            => uint256) public retiredByNation;
    mapping(address           => uint256) public retiredByEntity;
    mapping(CompliancePurpose => uint256) public retiredByPurpose;
    mapping(uint16            => uint256) public retiredByVintage;

    // ─────────────────────────────────────────────────────
    //  EVENTS
    // ─────────────────────────────────────────────────────

    event RegistryAdded(address indexed registry, bytes2 indexed nationCode);
    event RegistryRemoved(address indexed registry);

    event CreditRetiredGlobal(
        uint256 indexed tokenId,
        bytes2  indexed nationCode,
        address indexed retiringEntity,
        string  purpose,
        string  complianceRef,
        uint64  retiredAt
    );

    // ─────────────────────────────────────────────────────
    //  CONSTRUCTOR
    // ─────────────────────────────────────────────────────

    constructor(address admin) {
        if (admin == address(0)) revert InvalidAdmin();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    // ─────────────────────────────────────────────────────
    //  REGISTRY MANAGEMENT
    // ─────────────────────────────────────────────────────

    /// @notice Authorize a national registry contract to record retirements.
    /// @param  registry   Address of the SovereignRegistry contract to authorize.
    /// @param  nationCode ISO 3166-1 alpha-2 code for the nation this registry represents.
    function addRegistry(address registry, bytes2 nationCode) external onlyRole(ADMIN_ROLE) {
        if (registry   == address(0)) revert InvalidRegistry();
        if (nationCode == bytes2(0))  revert InvalidNationCode();
        _grantRole(REGISTRY_ROLE, registry);
        registryNation[registry] = nationCode;
        emit RegistryAdded(registry, nationCode);
    }

    /// @notice Revoke a registry's authorization.
    /// @param  registry Address of the registry to remove.
    function removeRegistry(address registry) external onlyRole(ADMIN_ROLE) {
        _revokeRole(REGISTRY_ROLE, registry);
        delete registryNation[registry];
        emit RegistryRemoved(registry);
    }

    // ─────────────────────────────────────────────────────
    //  RECORD RETIREMENT
    // ─────────────────────────────────────────────────────

    /// @notice Record a retirement permanently. Called by an authorized national registry.
    ///         This record is immutable — it can never be deleted or modified.
    /// @param  record Fully populated RetirementRecord to append to the ledger.
    /// @return ledgerIndex Zero-based index of the new record in the ledger array.
    function recordRetirement(
        RetirementRecord calldata record
    ) external onlyRole(REGISTRY_ROLE) returns (uint256 ledgerIndex) {
        // Caller may only record retirements for its own nation
        bytes2 expected = registryNation[msg.sender];
        if (expected != record.nationCode) revert WrongNation(expected, record.nationCode);

        // Input validation
        if (record.tokenId == 0)                       revert InvalidTokenId();
        if (record.nationCode == bytes2(0))            revert InvalidNationCode();
        if (record.retiringEntity == address(0))       revert InvalidEntity();
        if (record.retiredAt == 0)                     revert InvalidTimestamp();
        if (bytes(record.purpose).length == 0)         revert PurposeRequired();
        if (bytes(record.serialId).length == 0)        revert SerialRequired();

        // Prevent the same (nation, tokenId) pair being recorded twice
        if (_alreadyRecorded[record.nationCode][record.tokenId])
            revert AlreadyRecorded(record.nationCode, record.tokenId);
        _alreadyRecorded[record.nationCode][record.tokenId] = true;

        ledger.push(record);
        ledgerIndex = ledger.length - 1;

        unchecked {
            retiredByNation[record.nationCode]++;
            retiredByEntity[record.retiringEntity]++;
            retiredByPurpose[record.purposeCode]++;
            retiredByVintage[record.vintageYear]++;
        }

        emit CreditRetiredGlobal(
            record.tokenId,
            record.nationCode,
            record.retiringEntity,
            record.purpose,
            record.complianceRef,
            record.retiredAt
        );
    }

    // ─────────────────────────────────────────────────────
    //  VIEWS
    // ─────────────────────────────────────────────────────

    /// @notice Total number of retirement records in the ledger.
    function totalRetired() external view returns (uint256) {
        return ledger.length;
    }

    /// @notice Fetch a retirement record by its ledger index.
    /// @param  index Zero-based position in the ledger array.
    function getRetirement(uint256 index) external view returns (RetirementRecord memory) {
        if (index >= ledger.length) revert IndexOutOfRange(index, ledger.length);
        return ledger[index];
    }

    /// @notice Fetch the most recent `count` retirement records in chronological order.
    /// @param  count Maximum number of records to return; capped at ledger length.
    function getRecentRetirements(uint256 count)
        external view returns (RetirementRecord[] memory records)
    {
        uint256 total = ledger.length;
        uint256 n = count > total ? total : count;
        records = new RetirementRecord[](n);
        unchecked {
            for (uint256 i = 0; i < n; i++) {
                records[i] = ledger[total - n + i];
            }
        }
    }

    /// @notice Check if a specific (nationCode, tokenId) has already been recorded.
    function isRecorded(bytes2 nationCode, uint256 tokenId) external view returns (bool) {
        return _alreadyRecorded[nationCode][tokenId];
    }
}
