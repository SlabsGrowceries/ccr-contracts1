// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "./CRSToken.sol";
import "./MRVOracle.sol";
import "./RetirementVault.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/// @title Sovereign Registry — National Carbon Credit Mint Authority
/// @notice Each nation deploys one instance of this contract.
///         The government holds REGISTRY_ADMIN and controls all minting.
///         CCR holds OPERATOR and manages infrastructure only.
///         CCR cannot mint, burn, or modify credits without government approval.
///
///         SOVEREIGNTY GUARANTEE: The government can call revokeRole(OPERATOR, ccrAddress)
///         at any time. All tokens remain valid. CCR is out. Enforced by code.
contract SovereignRegistry is ERC721, AccessControl, Pausable {

    // ─────────────────────────────────────────────────────
    //  ERRORS
    // ─────────────────────────────────────────────────────

    error InvalidGovernment();
    error InvalidOracle();
    error InvalidOperator();
    error InvalidNationCode();
    error AttestationNotFinalized();
    error EmptySerial();
    error DuplicateSerial();
    error InvalidProjectId();
    error InvalidMonitoringPeriod();
    /// @param year The vintage year that failed validation
    error InvalidVintageYear(uint16 year);
    error InvalidTonne();
    error InvalidArea();
    /// @param expected This registry's nationCode
    /// @param provided issuingChainId on the credit being minted
    error WrongIssuingChain(bytes2 expected, bytes2 provided);
    /// @param tokenId The token the caller does not own
    error NotOwner(uint256 tokenId);
    /// @param tokenId Token whose current status prevents retirement
    error NotRetirable(uint256 tokenId);
    error ReasonRequired();
    /// @param tokenId Token that is retired and therefore locked
    error TransferBlockedRetired(uint256 tokenId);
    /// @param tokenId Token that is suspended and therefore locked
    error TransferBlockedSuspended(uint256 tokenId);
    error RegistryPaused();
    /// @param tokenId Token whose status cannot be suspended
    error NotSuspendable(uint256 tokenId);
    /// @param tokenId Token that is not in SUSPENDED status
    error NotSuspended(uint256 tokenId);
    error ProposalPending();
    error NoPendingUpdate();
    /// @param validAfter Timestamp after which the timelock expires
    error TimelockNotExpired(uint64 validAfter);
    /// @param tokenId Token whose status cannot be listed
    error NotListable(uint256 tokenId);
    /// @param tokenId Token that is not in LISTED status
    error NotListed(uint256 tokenId);

    // ─────────────────────────────────────────────────────
    //  ROLES
    // ─────────────────────────────────────────────────────

    bytes32 public constant REGISTRY_ADMIN = keccak256("REGISTRY_ADMIN"); // DRC government
    bytes32 public constant OPERATOR       = keccak256("OPERATOR");       // CCR infrastructure
    bytes32 public constant AUDITOR_ROLE   = keccak256("AUDITOR_ROLE");   // MRV verification bodies

    // ─────────────────────────────────────────────────────
    //  STATE
    // ─────────────────────────────────────────────────────

    bytes2  public nationCode;
    string  public nationName;

    uint256 public totalMinted;
    uint256 public totalRetired;
    uint256 public totalSuspended;

    MRVOracle       public oracle;
    RetirementVault public vault;  // optional — zero address if vault is on a different chain
    string          private _baseTokenURI;

    uint256 public constant TIMELOCK_DELAY = 2 days;

    // Pending timelocked oracle replacement — validAfter == 0 means no pending update
    address public pendingOracle;
    uint64  public pendingOracleValidAfter;

    // Pending timelocked vault replacement — validAfter == 0 means no pending update
    address public pendingVault;
    uint64  public pendingVaultValidAfter;

    mapping(uint256 => CarbonCredit) public credits;
    mapping(string  => bool)         private _serialUsed;
    mapping(bytes32 => uint256[])    public projectTokens;

    // ─────────────────────────────────────────────────────
    //  EVENTS
    // ─────────────────────────────────────────────────────

    event CreditMinted(uint256 indexed tokenId, string serialId, bytes32 indexed projectId, address indexed mintedBy);
    event CreditRetired(uint256 indexed tokenId, address indexed retiredBy, string reason);
    event CreditSuspended(uint256 indexed tokenId, address indexed suspendedBy);
    event CreditReinstated(uint256 indexed tokenId, address indexed reinstatedBy);
    event CreditListed(uint256 indexed tokenId, address indexed listedBy);
    event CreditUnlisted(uint256 indexed tokenId, address indexed unlistedBy);
    event OracleUpdateProposed(address indexed newOracle, uint64 validAfter);
    event OracleUpdated(address indexed oldOracle, address indexed newOracle);
    event OracleUpdateCancelled(address indexed cancelledOracle);
    event VaultUpdateProposed(address indexed newVault, uint64 validAfter);
    event VaultUpdated(address indexed oldVault, address indexed newVault);
    event VaultUpdateCancelled(address indexed cancelledVault);
    event BaseURIUpdated(string oldURI, string newURI);
    event VaultRecordFailed(uint256 indexed tokenId, bytes2 indexed nationCode);
    /// @notice Emitted after every state-changing operation so IBC relayers and
    ///         off-chain monitors always have a fresh stats snapshot to consume.
    ///         Anyone may re-emit via broadcastStats() if an event was missed.
    event NCRIStatsBroadcast(
        bytes2  indexed nationCode,
        uint256 totalMinted,
        uint256 totalActive,
        uint256 totalRetired,
        uint256 totalSuspended,
        uint64  timestamp
    );

    // ─────────────────────────────────────────────────────
    //  CONSTRUCTOR
    // ─────────────────────────────────────────────────────

    constructor(
        address governmentAdmin,
        address ccrOperator,
        address oracleAddress,
        bytes2  _nationCode,
        string memory _nationName
    ) ERC721("Congo Carbon Reserve", "CRS") {
        if (governmentAdmin == address(0)) revert InvalidGovernment();
        if (oracleAddress   == address(0)) revert InvalidOracle();
        if (ccrOperator     == address(0)) revert InvalidOperator();
        if (_nationCode     == bytes2(0))  revert InvalidNationCode();

        _grantRole(DEFAULT_ADMIN_ROLE, governmentAdmin);
        _grantRole(REGISTRY_ADMIN, governmentAdmin);
        _grantRole(OPERATOR, ccrOperator);

        oracle     = MRVOracle(oracleAddress);
        nationCode = _nationCode;
        nationName = _nationName;
    }

    // ─────────────────────────────────────────────────────
    //  MINTING — government only
    // ─────────────────────────────────────────────────────

    /// @notice Mint a new CRS carbon credit token.
    /// @dev    Only the government (REGISTRY_ADMIN) can call this.
    ///         The oracle must have a finalized attestation before minting is allowed.
    ///         All state is written before _safeMint to follow Checks-Effects-Interactions.
    /// @param  credit     Fully populated CarbonCredit struct to register on-chain.
    /// @dev    Second parameter (oracleProof) is reserved for ZK proof integration in Phase 2.
    /// @return tokenId    ERC721 token ID assigned to this credit.
    function mintCredit(
        CarbonCredit calldata credit,
        bytes calldata /* oracleProof */
    ) external onlyRole(REGISTRY_ADMIN) whenNotPaused returns (uint256 tokenId) {
        // 1. MRV oracle attestation — also verifies parcel hash matches what auditors signed
        if (!oracle.verifyAttestation(credit.attestation, credit.parcel.geojsonHash, ""))
            revert AttestationNotFinalized();

        // 2. Serial number — must be set and globally unique
        if (bytes(credit.serialId).length == 0) revert EmptySerial();
        if (_serialUsed[credit.serialId])        revert DuplicateSerial();

        // 3. Project ID
        if (credit.projectId == bytes32(0)) revert InvalidProjectId();

        // 4. Monitoring period
        if (credit.monitoringEnd <= credit.monitoringStart) revert InvalidMonitoringPeriod();

        // 5. Vintage year
        if (credit.vintageYear < 2020 || credit.vintageYear > 2100)
            revert InvalidVintageYear(credit.vintageYear);

        // 6. Carbon amount and parcel area
        if (credit.tonneCO2e == 0)            revert InvalidTonne();
        if (credit.parcel.areaHectares == 0)  revert InvalidArea();

        // 7. Issuing chain must match this registry's nation
        if (credit.issuingChainId != nationCode)
            revert WrongIssuingChain(nationCode, credit.issuingChainId);

        // 8. Write all state BEFORE _safeMint — prevents reentrancy via onERC721Received (CEI)
        unchecked { tokenId = ++totalMinted; }

        _serialUsed[credit.serialId] = true;
        projectTokens[credit.projectId].push(tokenId);

        credits[tokenId]                = credit;
        credits[tokenId].status         = TokenStatus.ACTIVE;
        credits[tokenId].mintedAt       = uint64(block.timestamp);
        credits[tokenId].retiredAt      = 0;
        credits[tokenId].retiredBy      = address(0);
        credits[tokenId].retirementReason = "";

        // 9. External calls last (CEI)
        _safeMint(msg.sender, tokenId);

        emit CreditMinted(tokenId, credit.serialId, credit.projectId, msg.sender);
        emit NCRIStatsBroadcast(nationCode, totalMinted,
            totalMinted - totalRetired - totalSuspended,
            totalRetired, totalSuspended, uint64(block.timestamp));
    }

    // ─────────────────────────────────────────────────────
    //  RETIREMENT — token owner
    // ─────────────────────────────────────────────────────

    /// @notice Permanently retire a credit — claims the carbon offset.
    /// @dev    The token is NOT burned; it remains on-chain as immutable proof.
    ///         Status becomes RETIRED irreversibly. The token can no longer be transferred.
    ///         If a vault is configured, the retirement is auto-recorded globally.
    ///         try/catch ensures vault failure never blocks a legitimate retirement.
    /// @param  tokenId     ERC721 token to retire.
    /// @param  reason      Human-readable retirement reason (e.g. "CORSIA Q3 2032").
    /// @param  purposeCode Compliance framework under which this credit is being retired.
    function retireCredit(
        uint256 tokenId,
        string calldata reason,
        CompliancePurpose purposeCode
    ) external whenNotPaused {
        if (ownerOf(tokenId) != msg.sender)    revert NotOwner(tokenId);

        CarbonCredit storage c = credits[tokenId];
        if (c.status != TokenStatus.ACTIVE && c.status != TokenStatus.LISTED)
            revert NotRetirable(tokenId);
        if (bytes(reason).length == 0) revert ReasonRequired();

        // Effects first (CEI)
        c.status           = TokenStatus.RETIRED;
        c.retiredAt        = uint64(block.timestamp);
        c.retiredBy        = msg.sender;
        c.retirementReason = reason;
        unchecked { totalRetired++; }

        emit CreditRetired(tokenId, msg.sender, reason);
        emit NCRIStatsBroadcast(nationCode, totalMinted,
            totalMinted - totalRetired - totalSuspended,
            totalRetired, totalSuspended, uint64(block.timestamp));

        // Auto-record in global vault if configured (external calls last — CEI)
        if (address(vault) != address(0)) {
            RetirementVault.RetirementRecord memory record = RetirementVault.RetirementRecord({
                tokenId:         tokenId,
                serialId:        c.serialId,
                nationCode:      nationCode,
                retiringEntity:  msg.sender,
                entityName:      "",
                purposeCode:     purposeCode,
                purpose:         reason,
                complianceRef:   "",
                vintageYear:     c.vintageYear,
                retiredAt:       c.retiredAt,
                attestationHash: keccak256(abi.encodePacked(
                    c.attestation.satelliteHash,
                    c.attestation.reportHash
                ))
            });
            try vault.recordRetirement(record) {
                // recorded successfully
            } catch {
                // Vault unavailable — retirement still succeeds on-chain.
                // Off-chain monitors must re-submit the record manually.
                emit VaultRecordFailed(tokenId, nationCode);
            }
        }
    }

    // ─────────────────────────────────────────────────────
    //  MARKETPLACE LISTING — token owner
    // ─────────────────────────────────────────────────────

    /// @notice List an ACTIVE credit on the NCRI marketplace.
    /// @param  tokenId ERC721 token to list.
    function listCredit(uint256 tokenId) external whenNotPaused {
        if (ownerOf(tokenId) != msg.sender) revert NotOwner(tokenId);
        CarbonCredit storage c = credits[tokenId];
        if (c.status != TokenStatus.ACTIVE) revert NotListable(tokenId);
        c.status = TokenStatus.LISTED;
        emit CreditListed(tokenId, msg.sender);
    }

    /// @notice Remove a credit from the NCRI marketplace listing.
    /// @param  tokenId ERC721 token to unlist.
    function unlistCredit(uint256 tokenId) external whenNotPaused {
        if (ownerOf(tokenId) != msg.sender) revert NotOwner(tokenId);
        CarbonCredit storage c = credits[tokenId];
        if (c.status != TokenStatus.LISTED) revert NotListed(tokenId);
        c.status = TokenStatus.ACTIVE;
        emit CreditUnlisted(tokenId, msg.sender);
    }

    // ─────────────────────────────────────────────────────
    //  SUSPENSION — auditor
    // ─────────────────────────────────────────────────────

    /// @notice Suspend a credit pending investigation.
    /// @dev    Intentionally NOT gated by whenNotPaused — emergency suspension must
    ///         remain possible even during a registry-wide pause. Pause is a freeze on
    ///         economic activity (minting, retiring, transferring), not on oversight.
    /// @param  tokenId ERC721 token to suspend.
    function suspendCredit(uint256 tokenId) external onlyRole(AUDITOR_ROLE) {
        CarbonCredit storage c = credits[tokenId];
        if (c.status != TokenStatus.ACTIVE && c.status != TokenStatus.LISTED)
            revert NotSuspendable(tokenId);
        c.status = TokenStatus.SUSPENDED;
        unchecked { totalSuspended++; }
        emit CreditSuspended(tokenId, msg.sender);
        emit NCRIStatsBroadcast(nationCode, totalMinted,
            totalMinted - totalRetired - totalSuspended,
            totalRetired, totalSuspended, uint64(block.timestamp));
    }

    /// @notice Reinstate a suspended credit after investigation clears.
    /// @dev    Intentionally NOT gated by whenNotPaused — the government must be able
    ///         to clear a wrongly suspended credit even during an emergency pause.
    /// @param  tokenId ERC721 token to reinstate.
    function reinstateCredit(uint256 tokenId) external onlyRole(REGISTRY_ADMIN) {
        CarbonCredit storage c = credits[tokenId];
        if (c.status != TokenStatus.SUSPENDED) revert NotSuspended(tokenId);
        c.status = TokenStatus.ACTIVE;
        unchecked { totalSuspended--; }
        emit CreditReinstated(tokenId, msg.sender);
        emit NCRIStatsBroadcast(nationCode, totalMinted,
            totalMinted - totalRetired - totalSuspended,
            totalRetired, totalSuspended, uint64(block.timestamp));
    }

    // ─────────────────────────────────────────────────────
    //  TRANSFER GUARD
    // ─────────────────────────────────────────────────────

    /// @notice Block transfers of RETIRED and SUSPENDED tokens; enforce pause.
    /// @dev    OZ v5 hook called on every mint, transfer, and burn.
    ///         Mints (from == address(0)) and burns (to == address(0)) pass through.
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            if (paused()) revert RegistryPaused();
            TokenStatus s = credits[tokenId].status;
            if (s == TokenStatus.RETIRED)   revert TransferBlockedRetired(tokenId);
            if (s == TokenStatus.SUSPENDED) revert TransferBlockedSuspended(tokenId);
        }
        return super._update(to, tokenId, auth);
    }

    // ─────────────────────────────────────────────────────
    //  ORACLE MANAGEMENT — government only
    // ─────────────────────────────────────────────────────

    /// @notice Propose an oracle replacement — takes effect after TIMELOCK_DELAY.
    ///         Prevents a compromised key from instantly redirecting attestations.
    /// @param  newOracle Address of the replacement MRVOracle contract.
    function proposeOracleUpdate(address newOracle) external onlyRole(REGISTRY_ADMIN) {
        if (pendingOracleValidAfter != 0) revert ProposalPending();
        if (newOracle == address(0))      revert InvalidOracle();
        pendingOracle = newOracle;
        pendingOracleValidAfter = uint64(block.timestamp + TIMELOCK_DELAY);
        emit OracleUpdateProposed(newOracle, pendingOracleValidAfter);
    }

    /// @notice Execute a proposed oracle replacement after the timelock expires.
    function executeOracleUpdate() external onlyRole(REGISTRY_ADMIN) {
        if (pendingOracleValidAfter == 0)               revert NoPendingUpdate();
        if (block.timestamp < pendingOracleValidAfter)  revert TimelockNotExpired(pendingOracleValidAfter);
        address old = address(oracle);
        oracle = MRVOracle(pendingOracle);
        pendingOracle = address(0);
        pendingOracleValidAfter = 0;
        emit OracleUpdated(old, address(oracle));
    }

    /// @notice Cancel a pending oracle proposal.
    function cancelOracleUpdate() external onlyRole(REGISTRY_ADMIN) {
        if (pendingOracleValidAfter == 0) revert NoPendingUpdate();
        address cancelled = pendingOracle;
        pendingOracle = address(0);
        pendingOracleValidAfter = 0;
        emit OracleUpdateCancelled(cancelled);
    }

    // ─────────────────────────────────────────────────────
    //  VAULT MANAGEMENT — government only
    // ─────────────────────────────────────────────────────

    /// @notice Propose a vault replacement — takes effect after TIMELOCK_DELAY.
    ///         Pass address(0) to propose disabling auto-recording.
    /// @param  newVault Address of the replacement RetirementVault, or zero to disable.
    function proposeVaultUpdate(address newVault) external onlyRole(REGISTRY_ADMIN) {
        if (pendingVaultValidAfter != 0) revert ProposalPending();
        pendingVault = newVault;
        pendingVaultValidAfter = uint64(block.timestamp + TIMELOCK_DELAY);
        emit VaultUpdateProposed(newVault, pendingVaultValidAfter);
    }

    /// @notice Execute a proposed vault replacement after the timelock expires.
    function executeVaultUpdate() external onlyRole(REGISTRY_ADMIN) {
        if (pendingVaultValidAfter == 0)               revert NoPendingUpdate();
        if (block.timestamp < pendingVaultValidAfter)  revert TimelockNotExpired(pendingVaultValidAfter);
        emit VaultUpdated(address(vault), pendingVault);
        vault = RetirementVault(pendingVault);
        pendingVault = address(0);
        pendingVaultValidAfter = 0;
    }

    /// @notice Cancel a pending vault proposal.
    function cancelVaultUpdate() external onlyRole(REGISTRY_ADMIN) {
        if (pendingVaultValidAfter == 0) revert NoPendingUpdate();
        address cancelled = pendingVault;
        pendingVault = address(0);
        pendingVaultValidAfter = 0;
        emit VaultUpdateCancelled(cancelled);
    }

    // ─────────────────────────────────────────────────────
    //  PAUSE — government only
    // ─────────────────────────────────────────────────────

    /// @notice Pause all minting, retirement, and transfers — emergency stop.
    function pause()   external onlyRole(REGISTRY_ADMIN) { _pause(); }

    /// @notice Resume normal operations.
    function unpause() external onlyRole(REGISTRY_ADMIN) { _unpause(); }

    // ─────────────────────────────────────────────────────
    //  METADATA
    // ─────────────────────────────────────────────────────

    /// @notice Update the base URI used to build token metadata URLs.
    ///         tokenURI returns baseURI + serialId, e.g.:
    ///         "https://registry.ccr.earth/CD/" + "CRS#DRC-2031-000001"
    /// @param  baseURI New base URI string.
    function setBaseURI(string calldata baseURI) external onlyRole(REGISTRY_ADMIN) {
        emit BaseURIUpdated(_baseTokenURI, baseURI);
        _baseTokenURI = baseURI;
    }

    /// @notice Returns the metadata URI for a token using its human-readable serial ID.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        if (bytes(_baseTokenURI).length == 0) return "";
        return string(abi.encodePacked(_baseTokenURI, credits[tokenId].serialId));
    }

    // ─────────────────────────────────────────────────────
    //  VIEWS
    // ─────────────────────────────────────────────────────

    /// @notice Get the full CarbonCredit struct for a token.
    ///         Required by external contracts (e.g. CarbonPool) — the auto-generated
    ///         public mapping getter cannot be assigned to a struct from outside the contract.
    /// @dev    Reverts with ERC721NonexistentToken if tokenId has not been minted,
    ///         preventing callers from receiving a misleading zero-valued struct.
    function getCredit(uint256 tokenId) external view returns (CarbonCredit memory) {
        _requireOwned(tokenId);
        return credits[tokenId];
    }

    /// @notice Get all token IDs for a given project.
    function getProjectTokens(bytes32 projectId) external view returns (uint256[] memory) {
        return projectTokens[projectId];
    }

    /// @notice Total active (non-retired, non-suspended) credits.
    function totalActive() external view returns (uint256) {
        return totalMinted - totalRetired - totalSuspended;
    }

    /// @notice Re-emit current stats as NCRIStatsBroadcast — call this if a relayer
    ///         missed an event and needs to re-sync the NCRI index. Anyone can call;
    ///         the only cost is the gas for one event.
    function broadcastStats() external {
        emit NCRIStatsBroadcast(
            nationCode,
            totalMinted,
            totalMinted - totalRetired - totalSuspended,
            totalRetired,
            totalSuspended,
            uint64(block.timestamp)
        );
    }

    // ─────────────────────────────────────────────────────
    //  REQUIRED OVERRIDES
    // ─────────────────────────────────────────────────────

    function supportsInterface(bytes4 interfaceId)
        public view override(ERC721, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
