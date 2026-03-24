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
    /// Destination address for withdrawFees must be non-zero.
    error InvalidRecipient();
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
    /// Beneficiary address must be set — required for UNFCCC Art. 6.2 corresponding adjustments
    error InvalidBeneficiary();
    /// @param sent    msg.value supplied
    /// @param required Minimum fee required per retirement record
    error InsufficientRetirementFee(uint256 sent, uint256 required);
    /// @param feeWei  Fee that was supplied
    /// @param maximum Hard cap — MAX_RETIREMENT_FEE_WEI
    error RetirementFeeTooHigh(uint256 feeWei, uint256 maximum);

    // ─────────────────────────────────────────────────────
    //  ROLES
    // ─────────────────────────────────────────────────────

    bytes32 public constant REGISTRY_ROLE = keccak256("REGISTRY_ROLE");
    bytes32 public constant ADMIN_ROLE    = keccak256("ADMIN_ROLE");

    /// @notice Hard cap on per-retirement fee — prevents a compromised admin from
    ///         bricking all retirements by setting an astronomically high fee.
    ///         Analogous to CarbonPool's MAX_FEE_BPS hard cap.
    uint256 public constant MAX_RETIREMENT_FEE_WEI = 1 ether;

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
        /// @dev Final offsetting entity — may differ from retiringEntity under Art. 6.2 ITMOs.
        ///      E.g. retiringEntity = Shell (the broker), beneficiaryAddress = Lufthansa (the airline).
        ///      Required: UNFCCC Art. 6 corresponding-adjustment reporting and CORSIA MRV.
        address           beneficiaryAddress;
        string            beneficiaryName;
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
    /// @notice Credits retired on behalf of each beneficiary — key for Art. 6.2 accounting.
    mapping(address           => uint256) public retiredByBeneficiary;

    // ─────────────────────────────────────────────────────
    //  PLATFORM FEE
    // ─────────────────────────────────────────────────────

    /// @notice Fee in wei charged per retirement record. Zero = no fee (default).
    ///         When non-zero, recordRetirement() is payable and requires msg.value >= this amount.
    ///         Excess ETH above the fee is refunded to the caller.
    ///         Set via setRetirementFee(); raise before activating for large-scale registries.
    uint256 public retirementFeeWei;

    /// @notice Address that receives accumulated platform fees.
    ///         Zero = fee collection disabled even if retirementFeeWei > 0.
    address public feeRecipient;

    /// @notice Registries whose retirement records are permanently fee-exempt.
    ///         Use for founding-partner waivers (e.g. Congo, Liberia during onboarding).
    ///         Fee is still visible on-chain (retirementFeeWei > 0) — the waiver is
    ///         a provable on-chain grant, not a silent discount.
    mapping(address => bool) public feeWaived;

    // ─────────────────────────────────────────────────────
    //  EVENTS
    // ─────────────────────────────────────────────────────

    event RegistryAdded(address indexed registry, bytes2 indexed nationCode);
    event RegistryRemoved(address indexed registry);
    event RetirementFeeUpdated(uint256 oldFee, uint256 newWei);
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event FeeWaiverUpdated(address indexed registry, bool waived);

    event CreditRetiredGlobal(
        uint256 indexed tokenId,
        bytes2  indexed nationCode,
        address indexed retiringEntity,
        address         beneficiaryAddress,
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
    ///         When retirementFeeWei > 0 and feeRecipient is set, msg.value must cover
    ///         the fee. Any ETH above the fee is refunded to the caller.
    ///         Fee starts at zero — existing SovereignRegistry integration requires no changes
    ///         until the fee is activated by governance.
    /// @param  record Fully populated RetirementRecord to append to the ledger.
    /// @return ledgerIndex Zero-based index of the new record in the ledger array.
    function recordRetirement(
        RetirementRecord calldata record
    ) external payable onlyRole(REGISTRY_ROLE) returns (uint256 ledgerIndex) {
        // ── CHECKS ────────────────────────────────────────────────────────────
        // Caller may only record retirements for its own nation
        bytes2 expected = registryNation[msg.sender];
        if (expected != record.nationCode) revert WrongNation(expected, record.nationCode);

        // Input validation
        if (record.tokenId == 0)                       revert InvalidTokenId();
        if (record.nationCode == bytes2(0))            revert InvalidNationCode();
        if (record.retiringEntity == address(0))       revert InvalidEntity();
        if (record.beneficiaryAddress == address(0))   revert InvalidBeneficiary();
        if (record.retiredAt == 0)                     revert InvalidTimestamp();
        if (bytes(record.purpose).length == 0)         revert PurposeRequired();
        if (bytes(record.serialId).length == 0)        revert SerialRequired();

        // Prevent the same (nation, tokenId) pair being recorded twice
        if (_alreadyRecorded[record.nationCode][record.tokenId])
            revert AlreadyRecorded(record.nationCode, record.tokenId);

        // Fee check — validate msg.value before any state changes
        bool feeActive = retirementFeeWei > 0 && feeRecipient != address(0) && !feeWaived[msg.sender];
        if (feeActive && msg.value < retirementFeeWei)
            revert InsufficientRetirementFee(msg.value, retirementFeeWei);

        // ── EFFECTS ───────────────────────────────────────────────────────────
        _alreadyRecorded[record.nationCode][record.tokenId] = true;

        ledger.push(record);
        ledgerIndex = ledger.length - 1;

        unchecked {
            retiredByNation[record.nationCode]++;
            retiredByEntity[record.retiringEntity]++;
            retiredByPurpose[record.purposeCode]++;
            retiredByVintage[record.vintageYear]++;
            retiredByBeneficiary[record.beneficiaryAddress]++;
        }

        emit CreditRetiredGlobal(
            record.tokenId,
            record.nationCode,
            record.retiringEntity,
            record.beneficiaryAddress,
            record.purpose,
            record.complianceRef,
            record.retiredAt
        );

        // ── INTERACTIONS ──────────────────────────────────────────────────────
        // Forward exact fee to recipient; refund any excess to caller.
        // Executed last to comply with Checks-Effects-Interactions pattern.
        if (feeActive) {
            (bool sent,) = feeRecipient.call{value: retirementFeeWei}("");
            require(sent, "fee transfer failed");
            uint256 excess = msg.value - retirementFeeWei;
            if (excess > 0) {
                (bool refunded,) = msg.sender.call{value: excess}("");
                require(refunded, "refund failed");
            }
        }
    }

    // ─────────────────────────────────────────────────────
    //  PLATFORM FEE MANAGEMENT — admin only
    // ─────────────────────────────────────────────────────

    /// @notice Set the per-retirement platform fee in wei.
    ///         Zero disables fee collection entirely (default — backward compatible).
    ///         Raise this before a large registry onboarding event; lower it for
    ///         high-volume public good retirements.
    ///         When fee > 0, recordRetirement() callers must supply msg.value >= fee.
    ///         SovereignRegistry.retireCredit() must be updated to forward ETH before
    ///         activating a non-zero fee (V2 upgrade path).
    /// @param  feeWei New fee in wei per retirement record.
    function setRetirementFee(uint256 feeWei) external onlyRole(ADMIN_ROLE) {
        if (feeWei > MAX_RETIREMENT_FEE_WEI) revert RetirementFeeTooHigh(feeWei, MAX_RETIREMENT_FEE_WEI);
        uint256 old = retirementFeeWei;
        retirementFeeWei = feeWei;
        emit RetirementFeeUpdated(old, feeWei);
    }

    /// @notice Set the address that receives platform fees.
    ///         Pass address(0) to suspend fee collection without zeroing the rate.
    /// @param  recipient New fee recipient.
    function setFeeRecipient(address recipient) external onlyRole(ADMIN_ROLE) {
        address old = feeRecipient;
        feeRecipient = recipient;
        emit FeeRecipientUpdated(old, recipient);
    }

    /// @notice Grant or revoke a fee waiver for a specific registry.
    ///         Waived registries call recordRetirement() for free even when the global
    ///         fee is non-zero. Use for founding-partner agreements; revoke when the
    ///         waiver period expires with a single admin transaction.
    /// @param  registry Address of the SovereignRegistry to waive.
    /// @param  waived   True to grant waiver, false to revoke.
    function setFeeWaiver(address registry, bool waived) external onlyRole(ADMIN_ROLE) {
        feeWaived[registry] = waived;
        emit FeeWaiverUpdated(registry, waived);
    }

    /// @notice Withdraw any ETH accidentally sent directly to this contract
    ///         (fee forwarding failures, direct transfers, etc.).
    /// @param  to Destination address — must be non-zero.
    function withdrawFees(address payable to) external onlyRole(ADMIN_ROLE) {
        if (to == address(0)) revert InvalidRecipient();
        uint256 balance = address(this).balance;
        if (balance == 0) return;
        (bool sent,) = to.call{value: balance}("");
        require(sent, "withdraw failed");
        emit FeesWithdrawn(to, balance);
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
