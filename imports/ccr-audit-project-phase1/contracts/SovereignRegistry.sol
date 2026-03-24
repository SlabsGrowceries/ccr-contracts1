// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./MRVOracle.sol";
import "./RetirementVault.sol";

/// @title SovereignRegistry
/// @notice ERC-721 registry for sovereign carbon credits issued by governments
/// @dev Implements minting, retirement, suspension, and transfer controls with government sovereignty guarantee.
contract SovereignRegistry is ERC721, AccessControl, ReentrancyGuard, Pausable {
    bytes32 public constant GOVERNMENT_ROLE = keccak256("GOVERNMENT_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant AUDITOR_ROLE = keccak256("AUDITOR_ROLE");

    MRVOracle public oracle;
    RetirementVault public vault;
    uint256 public totalMinted;
    uint256 public totalRetired;
    mapping(uint256 => StoredCredit) public credits;
    mapping(bytes32 => bool) private _serialUsed;

    enum Status { INVALID, ACTIVE, SUSPENDED, RETIRED }

    struct Parcel {
        bytes32 geojsonHash;
        int256 centroidLat;
        int256 centroidLon;
        uint256 areaHectares;
    }

    struct Attestation {
        bytes32 satelliteHash;
        bytes32 geojsonHash;
        uint256 timestamp;
        address[] auditors;
        uint256 signatureCount;
        bool finalized;
    }

    struct CreditInput {
        string serialId;
        bytes2 issuingChainId;
        bytes32 projectId;
        uint8 projectType;
        string methodology;
        uint256 tonneCO2e;
        uint256 vintageYear;
        uint256 monitoringStart;
        uint256 monitoringEnd;
        Parcel parcel;
        Attestation attestation;
        uint8 status;
        uint256 mintedAt;
        uint256 retiredAt;
        address retiredBy;
        string retirementReason;
    }

    struct StoredCredit {
        string serialId;
        bytes2 issuingChainId;
        bytes32 projectId;
        uint8 projectType;
        string methodology;
        uint256 tonneCO2e;
        uint256 vintageYear;
        uint256 monitoringStart;
        uint256 monitoringEnd;
        Parcel parcel;
        Status status;
        uint256 mintedAt;
        uint256 retiredAt;
        address retiredBy;
        string retirementReason;
    }

    /// @notice Emitted when a government mints a new carbon credit
    event CreditMinted(uint256 indexed tokenId, bytes32 indexed projectId, address indexed government);
    
    /// @notice Emitted when a credit is permanently retired from circulation
    event CreditRetired(uint256 indexed tokenId, address indexed retiredBy);

    /// @notice Initialize the registry with oracle and vault references
    /// @param _oracle MRVOracle contract address for attestation verification
    /// @param government Government address to receive initial DEFAULT_ADMIN_ROLE and GOVERNMENT_ROLE
    /// @param _vault RetirementVault contract address for recording retirements
    constructor(address _oracle, address government, address _vault) ERC721("Sovereign Carbon Credit", "SCC") {
        oracle = MRVOracle(_oracle);
        vault = RetirementVault(_vault);
        _grantRole(DEFAULT_ADMIN_ROLE, government);
        _grantRole(GOVERNMENT_ROLE, government);
    }

    /// @notice Mint a new carbon credit after oracle attestation
    /// @param c Credit input struct containing all credit metadata and attestation
    /// @return tokenId The ID of the newly minted credit token
    function mintCredit(CreditInput calldata c) external onlyRole(GOVERNMENT_ROLE) nonReentrant whenNotPaused returns (uint256) {
        require(oracle.isFinalized(getAttestationId(c.attestation.satelliteHash, c.attestation.geojsonHash)), "MRV: attestation not finalized");
        require(bytes(c.serialId).length > 0, "EMPTY_SERIAL");
        require(c.projectId != bytes32(0), "INVALID_PROJECT_ID");
        require(c.tonneCO2e > 0, "INVALID_TONNE");
        require(c.parcel.areaHectares > 0, "INVALID_AREA");

        bytes32 serialKey = keccak256(bytes(c.serialId));
        require(!_serialUsed[serialKey], "DUPLICATE_SERIAL");

        uint256 tokenId = ++totalMinted;

        StoredCredit storage s = credits[tokenId];
        s.serialId = c.serialId;
        s.issuingChainId = c.issuingChainId;
        s.projectId = c.projectId;
        s.projectType = c.projectType;
        s.methodology = c.methodology;
        s.tonneCO2e = c.tonneCO2e;
        s.vintageYear = c.vintageYear;
        s.monitoringStart = c.monitoringStart;
        s.monitoringEnd = c.monitoringEnd;
        s.parcel = c.parcel;
        s.status = Status.ACTIVE;
        s.mintedAt = block.timestamp;

        _serialUsed[serialKey] = true;
        _safeMint(msg.sender, tokenId);

        emit CreditMinted(tokenId, c.projectId, msg.sender);
        return tokenId;
    }

    /// @notice Retire a credit from circulation, making it permanently inactive
    /// @param tokenId The ID of the credit to retire
    /// @param reason Audit reason for retirement (non-empty required)
    function retireCredit(uint256 tokenId, string calldata reason) external whenNotPaused {
        require(ownerOf(tokenId) == msg.sender, "NOT_OWNER");
        StoredCredit storage s = credits[tokenId];
        require(s.status == Status.ACTIVE, "NOT_RETIRABLE");
        require(bytes(reason).length > 0, "REASON_REQUIRED");

        s.status = Status.RETIRED;
        s.retiredAt = block.timestamp;
        s.retiredBy = msg.sender;
        s.retirementReason = reason;
        totalRetired++;

        // Record retirement in vault
        if (address(vault) != address(0)) {
            RetirementVault.RetirementRecord memory record = RetirementVault.RetirementRecord(
                tokenId,
                bytes2(0),
                reason,
                block.timestamp
            );
            vault.recordRetirement(record);
        }

        emit CreditRetired(tokenId, msg.sender);
    }

    /// @notice Suspend a credit due to fraud or compliance concerns (auditor only)
    /// @param tokenId The ID of the credit to suspend
    function suspendCredit(uint256 tokenId) external onlyRole(AUDITOR_ROLE) {
        credits[tokenId].status = Status.SUSPENDED;
    }

    /// @notice Reinstate a suspended credit back to active status
    /// @param tokenId The ID of the credit to reinstate
    function reinstateCredit(uint256 tokenId) external onlyRole(GOVERNMENT_ROLE) {
        credits[tokenId].status = Status.ACTIVE;
    }

    /// @notice Update the oracle contract reference
    /// @param _oracle New oracle address (must not be zero)
    function updateOracle(address _oracle) external onlyRole(GOVERNMENT_ROLE) {
        require(_oracle != address(0), "INVALID_ORACLE");
        oracle = MRVOracle(_oracle);
    }

    /// @notice Update the vault contract reference
    /// @param _vault New vault address (must not be zero)
    function updateVault(address _vault) external onlyRole(GOVERNMENT_ROLE) {
        require(_vault != address(0), "INVALID_VAULT");
        vault = RetirementVault(_vault);
    }

    /// @notice Pause all registry operations (emergency brake)
    function pause() external onlyRole(GOVERNMENT_ROLE) {
        _pause();
    }

    /// @notice Resume registry operations after pause
    function unpause() external onlyRole(GOVERNMENT_ROLE) {
        _unpause();
    }

    function _update(address to, uint256 tokenId, address auth) internal override whenNotPaused returns (address) {
        StoredCredit storage s = credits[tokenId];
        require(s.status != Status.RETIRED, "TRANSFER_BLOCKED: token is retired");
        require(s.status != Status.SUSPENDED, "TRANSFER_BLOCKED: token is suspended");
        return super._update(to, tokenId, auth);
    }

    /// @notice Derive attestation ID (matches oracle implementation)
    /// @param satelliteHash The satellite hash
    /// @return The attestation ID
    function getAttestationId(bytes32 satelliteHash, bytes32) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(satelliteHash));
    }

    /// @notice Support ERC-721 and AccessControl interfaces
    /// @param interfaceId Interface ID to check
    /// @return True if interface is supported
    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}