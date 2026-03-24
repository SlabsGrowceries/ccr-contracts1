# Sovereign Integration Guide for CCR Smart Contracts
# Version 1.0 - March 24, 2026

## Overview
This guide provides technical implementation details for integrating the Carbon Credit Registry (CCR) smart contracts into sovereign nation systems, military operations, and enterprise environments.

## Architecture Overview

### Core Contracts
- **MRVOracle**: Multi-signature attestation oracle for emissions verification
- **SovereignRegistry**: ERC-721 registry for carbon credits with government control
- **RetirementVault**: Immutable ledger for credit retirements
- **NCRIIndex**: Cross-nation carbon index for trading

### Deployment Architecture
```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Government    │────│  MRVOracle       │────│ Sovereign       │
│   Authority     │    │ (Multi-sig)      │    │ Registry        │
└─────────────────┘    └──────────────────┘    └─────────────────┘
         │                       │                       │
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│ Retirement      │    │ NCRI Index       │    │ Market          │
│ Vault           │    │ (Cross-nation)   │    │ Exchanges       │
│ (Immutable)     │    │                  │    │                 │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

## Deployment Process

### Phase 1: Infrastructure Setup
```bash
# 1. Deploy RetirementVault (no dependencies)
vaultAddress = deploy(RetirementVault, deployer)

# 2. Deploy MRVOracle
oracleAddress = deploy(MRVOracle, threshold=3)

# 3. Deploy SovereignRegistry
registryAddress = deploy(SovereignRegistry, oracleAddress, government, vaultAddress)

# 4. Deploy NCRIIndex
indexAddress = deploy(NCRIIndex, deployer)

# 5. Configure permissions
vault.addRegistry(registryAddress)
vault.grantRole(vault.REGISTRY_ROLE(), registryAddress)
index.grantRole(index.RELAYER_ROLE(), relayer)
```

### Phase 2: Role Configuration
```javascript
// Government roles
await registry.grantRole(await registry.GOVERNMENT_ROLE(), governmentAddress);
await registry.grantRole(await registry.OPERATOR_ROLE(), operatorAddress);

// Oracle auditors
await oracle.addAuditor(auditor1);
await oracle.addAuditor(auditor2);
await oracle.addAuditor(auditor3);

// Index nation registration
await index.addNation("0x5553", "United States");
await index.addNation("0x4348", "China");
```

## API Integration Points

### Credit Minting Workflow
```javascript
// 1. Prepare MRV data
const satelliteHash = ethers.keccak256(satelliteData);
const geojsonHash = ethers.keccak256(geojsonData);
const attestationId = await oracle.getAttestationId(satelliteHash, geojsonHash);

// 2. Submit attestations (3 auditors)
await oracle.connect(auditor1).submitAttestation(satelliteHash, geojsonHash);
await oracle.connect(auditor2).submitAttestation(satelliteHash, geojsonHash);
await oracle.connect(auditor3).submitAttestation(satelliteHash, geojsonHash);

// 3. Verify finalization
const isFinalized = await oracle.isFinalized(attestationId);
assert(isFinalized, "Attestation not finalized");

// 4. Mint credit
const creditInput = {
  serialId: "US-2026-001",
  issuingChainId: "0x0001",
  projectId: ethers.randomBytes(32),
  projectType: 1,
  methodology: "Forestry Conservation",
  tonneCO2e: 1000,
  vintageYear: 2026,
  monitoringStart: 1672531200,
  monitoringEnd: 1704067200,
  parcel: {
    geojsonHash: geojsonHash,
    centroidLat: 40000000, // 40.000000 * 10^6
    centroidLon: -120000000, // -120.000000 * 10^6
    areaHectares: 500
  },
  attestation: {
    satelliteHash: satelliteHash,
    geojsonHash: geojsonHash,
    timestamp: Math.floor(Date.now() / 1000),
    auditors: [auditor1, auditor2, auditor3],
    signatureCount: 3,
    finalized: true
  }
};

const tokenId = await registry.connect(government).mintCredit(creditInput);
```

### Retirement Workflow
```javascript
// 1. Check ownership
const owner = await registry.ownerOf(tokenId);
assert(owner === retiringParty, "Not token owner");

// 2. Retire credit
await registry.connect(retiringParty).retireCredit(tokenId, "CORSIA Compliance");

// 3. Verify retirement in vault
const isRecorded = await vault.isRecorded(tokenId, nationCode);
assert(isRecorded, "Retirement not recorded");
```

### Trading Integration
```javascript
// ERC-721 standard transfers
await registry.connect(seller).approve(marketplace, tokenId);
await registry.connect(marketplace).transferFrom(seller, buyer, tokenId);

// NCRI Index updates
await index.syncNationStats(nationCode, newSupply);
const weights = await index.rebalance();
```

## Key Management

### Government Keys
- **Cold Storage**: Government signing keys in secure HSM
- **Multi-sig**: 3/5 or 5/7 threshold for critical operations
- **Rotation**: Annual key rotation with overlap period

### Auditor Keys
- **Independent**: Each auditor maintains separate key infrastructure
- **Geographic Distribution**: Keys stored in different jurisdictions
- **Backup**: Shamir's secret sharing for key recovery

### Emergency Procedures
```javascript
// Emergency pause
await registry.connect(government).pause();

// Update oracle if compromised
await registry.connect(government).updateOracle(newOracleAddress);

// Emergency retirement (government override)
await registry.connect(government).emergencyRetire(tokenId, "Security Breach");
```

## Monitoring & Maintenance

### On-Chain Monitoring
```javascript
// Health checks
const totalMinted = await registry.totalMinted();
const totalRetired = await registry.totalRetired();
const activeSupply = await index.globalActiveSupply();

// Event monitoring
registry.on("CreditMinted", (tokenId, projectId, minter) => {
  logMintingEvent(tokenId, projectId, minter);
});

oracle.on("AttestationFinalized", (attestationId) => {
  triggerMintingWorkflow(attestationId);
});
```

### Off-Chain Infrastructure
- **Node Infrastructure**: Maintain archive nodes for historical data
- **Backup Systems**: Regular state snapshots
- **Alert Systems**: Monitor for unusual activity
- **Compliance Reporting**: Automated regulatory filings

## Compliance Workflows

### CORSIA Compliance
1. **Credit Verification**: MRV attestation confirms eligible reductions
2. **Retirement Recording**: Automatic vault recording for ICAO reporting
3. **Double-Counting Prevention**: Immutable retirement prevents reuse

### Article 6 Compliance
1. **Corresponding Adjustments**: Cross-registry retirement tracking
2. **Sovereign Control**: Nation-specific registries maintain autonomy
3. **Transparency**: Public ledger for international verification

### ESG Reporting
1. **Credit Tracking**: Token ownership provides audit trail
2. **Retirement Verification**: Vault records for disclosure
3. **Impact Measurement**: MRV data for quantitative reporting

## Security Considerations

### Access Control
- **Role Separation**: Government, auditors, operators have distinct permissions
- **Principle of Least Privilege**: Minimal permissions for each role
- **Audit Logging**: All permission changes logged

### Emergency Response
- **Pause Functionality**: Instant stop of all operations
- **Upgrade Mechanisms**: Proxy patterns for critical fixes
- **Incident Response**: Pre-defined procedures for breaches

### Data Privacy
- **Hashed Data**: Sensitive location data stored as hashes
- **Access Controls**: Private data only accessible to authorized parties
- **Anonymization**: Public data anonymized where possible

## Performance Optimization

### Gas Optimization
- **Batch Operations**: Group multiple operations in single transactions
- **Storage Packing**: Optimize struct layouts for gas efficiency
- **Event Optimization**: Minimize expensive operations

### Scalability
- **Layer 2 Solutions**: Compatible with Polygon, Arbitrum, Optimism
- **Sharding**: Contract design supports horizontal scaling
- **Caching**: Off-chain caching for frequently accessed data

## Troubleshooting

### Common Issues
1. **Attestation Not Finalizing**: Check auditor signatures and threshold
2. **Minting Reverts**: Verify oracle finalization and input validation
3. **Transfer Blocked**: Check token status (retired/suspended)

### Support Resources
- **Documentation**: Complete NatSpec in contract code
- **Test Suite**: 70 comprehensive tests for validation
- **Audit Reports**: Multiple independent security audits

## Migration Strategies

### From Legacy Systems
1. **Data Migration**: Batch import existing credits
2. **Oracle Integration**: Connect to existing MRV systems
3. **API Compatibility**: Maintain existing integration points

### Multi-Chain Deployment
1. **Bridge Integration**: Cross-chain credit transfers
2. **Oracle Networks**: Decentralized attestation networks
3. **Unified Interface**: Consistent API across chains

This guide provides the foundation for successful CCR integration. For specific implementation details, refer to the contract documentation and test suite.