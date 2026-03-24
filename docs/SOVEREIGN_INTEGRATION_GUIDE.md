# Sovereign Nation Integration Guide

**CCR Platform — Carbon Credit Registry**
Audience: National Ministry of Environment / Government IT Team
Version: 1.0 — March 2026

---

## Overview

This guide walks a national government IT team through the complete process of deploying the CCR smart-contract stack for their sovereign carbon-credit registry. After completing all eight sections, your nation will have an on-chain registry, oracle-verified credit minting, a retirement vault, and connection to the global NCRI index.

No prior Ethereum or DeFi experience is assumed. Each section explains what the contract does, who controls it, and what transactions to execute.

---

## Section 1 — Prerequisites

### Infrastructure requirements

| Item | Minimum spec |
|------|-------------|
| RPC endpoint | Arbitrum One (recommended) or Ethereum mainnet node |
| Deployer wallet | EOA or hardware wallet (Ledger/Trezor) with 0.2 ETH for gas |
| Node.js | v18 or later |
| Git | Any recent version |

### Key roles you will need to assign

| Role | Who holds it | What it allows |
|------|-------------|----------------|
| `REGISTRY_ADMIN` | Government ministry key | Minting, pausing, oracle/vault upgrades |
| `OPERATOR` | CCR infrastructure key | None that affect credits — read-only operations |
| `AUDITOR_ROLE` | 3–5 accredited MRV verifiers | Signing attestations on the oracle |

> **Sovereignty guarantee:** `REGISTRY_ADMIN` is the only role that can mint, pause, or replace system components. CCR holds `OPERATOR` only. Your government can revoke CCR's operator role at any time with a single transaction — all tokens remain valid.

### Repository setup

```bash
git clone https://github.com/ccr/ccr-contracts
cd ccr-contracts
npm install
cp .env.example .env
# Fill in: DEPLOYER_PRIVATE_KEY, ALCHEMY_API_KEY, ETHERSCAN_API_KEY
```

---

## Section 2 — Deploy MRVOracle

The `MRVOracle` collects multi-party attestations from accredited verifiers (VVBs). A credit cannot be minted until **at least 3 of 5 auditors** have signed the same satellite data, report hash, and parcel boundary.

### Deploy

```js
// scripts/deploy-oracle.js
const oracle = await MRVOracle.deploy(
  governmentAdminAddress,   // holds ADMIN_ROLE
  3                         // signing threshold (minimum 3, cannot go below)
);
console.log("Oracle deployed:", await oracle.getAddress());
```

Run:
```bash
npx hardhat run scripts/deploy-oracle.js --network arbitrum
```

### Add auditors

```js
// Add each of your 3–5 accredited MRV verifiers
await oracle.addAuditor("0xAuditor1...");
await oracle.addAuditor("0xAuditor2...");
await oracle.addAuditor("0xAuditor3...");
```

### Verify

```bash
npx hardhat verify --network arbitrum <ORACLE_ADDRESS> <ADMIN_ADDRESS> 3
```

---

## Section 3 — Deploy SovereignRegistry

The `SovereignRegistry` is the on-chain mint authority. Each nation deploys exactly one instance. It holds all carbon credits as ERC-721 tokens.

### Deploy

```js
// scripts/deploy-registry.js
const registry = await SovereignRegistry.deploy(
  governmentAdminAddress,   // REGISTRY_ADMIN — minting authority
  ccrOperatorAddress,       // OPERATOR — CCR infrastructure key (read-only)
  await oracle.getAddress(),// MRVOracle address from Section 2
  "0xCD",                   // ISO 3166-1 alpha-2 nation code, zero-padded to bytes2
                            //   e.g. "0xCD" = DRC, "0x4C" = Liberia, "0x47" = Gabon
  "Democratic Republic of Congo"  // human-readable nation name
);
```

> **Nation codes:** Use the hex encoding of your ISO 3166-1 alpha-2 code.
> DRC = "CD" = 0x4344 → pass `ethers.zeroPadBytes("0x43", 2)` for the bytes2 value.

### Grant AUDITOR_ROLE to verifiers on the registry

The auditors who will submit attestations also need `AUDITOR_ROLE` on the registry so they can suspend credits.

```js
const AUDITOR_ROLE = await registry.AUDITOR_ROLE();
await registry.connect(government).grantRole(AUDITOR_ROLE, "0xAuditor1...");
```

### Set base URI for token metadata (optional)

```js
await registry.connect(government).setBaseURI(
  "https://registry.ccr.earth/CD/"
  // Token URI will be: https://registry.ccr.earth/CD/CRS#DRC-2031-000001
);
```

---

## Section 4 — Deploy RetirementVault

The `RetirementVault` creates an immutable, globally queryable ledger of every carbon retirement. Registries call it automatically when a token is retired.

### Deploy

```js
// scripts/deploy-vault.js
const vault = await RetirementVault.deploy(adminAddress);

// Register your registry with its nation code
await vault.addRegistry(
  await registry.getAddress(),
  ethers.zeroPadBytes("0xCD", 2)  // your nation code
);
```

### Wire the vault into the registry (2-day timelock)

The vault address is protected by a timelock to prevent instant key compromise.

```js
// Day 1: propose
await registry.connect(government).proposeVaultUpdate(await vault.getAddress());

// Day 3 or later: execute
await registry.connect(government).executeVaultUpdate();
```

> The timelock requires waiting at least 2 calendar days between proposal and execution.
> After this, every retirement will automatically record to the vault.

### Configure the retirement fee (optional)

The fee starts at zero. To activate a per-retirement platform fee later:

```js
await vault.connect(admin).setRetirementFee(ethers.parseEther("0.01")); // 0.01 ETH
await vault.connect(admin).setFeeRecipient("0xCCRTreasury...");
```

> **Important:** If you activate a non-zero fee, update `SovereignRegistry.retireCredit` to forward `msg.value` to the vault. This is a V2 upgrade (see the Future Plan). Do not activate fees before the V2 upgrade is deployed.

---

## Section 5 — Configure KYC/AML Allowlist (optional)

If your national program requires KYC/AML screening of wallet addresses, deploy a contract implementing `IAllowlist` and wire it in.

### Deploy MockAllowlist (for testing) or integrate Chainalysis

```js
// Option A — managed whitelist (testnet/staging only)
const allowlist = await MockAllowlist.deploy();
await allowlist.allow("0xApprovedWallet...");

// Option B — Chainalysis on-chain oracle (production)
// Deploy the Chainalysis oracle per their integration guide, then:
const allowlistAddress = "0xChainalysisOracle...";
```

### Wire the allowlist into the registry

```js
await registry.connect(government).setAllowlist(allowlistAddress);
```

Once set, every ERC-721 transfer checks both sender and receiver against the list. Pass `address(0)` to disable screening.

---

## Section 6 — Set Minting Cap

The minting cap prevents runaway issuance from a compromised key and aligns on-chain supply with your quarterly MRV audit cycles.

### Example: 1,000,000 credits per quarter

```js
await registry.connect(government).setMintingCap(
  1_000_000,   // maximum credits per period
  90 * 86400   // 90 days in seconds
);
```

After the window expires, the counter resets automatically on the next mint call.

### Mint your first credit

1. Each auditor submits their attestation to the oracle:

```js
await oracle.connect(auditor1).submitAttestation(
  satelliteHash,   // keccak256 of your satellite imagery file
  reportHash,      // keccak256 of the MRV report PDF
  parcelHash       // keccak256 of the GeoJSON parcel boundary
);
// Repeat for auditor2, auditor3 — finalization is automatic at threshold
```

2. Government mints the credit:

```js
const credit = {
  serialId:        "CRS#CD-2031-000001",   // globally unique serial
  issuingChainId:  ethers.zeroPadBytes("0xCD", 2),  // must match registry nationCode
  projectId:       ethers.keccak256(ethers.toUtf8Bytes("KONGO-CENTRAL-001")),
  projectType:     0,                       // 0 = REDD+
  methodology:     "ART-TREES-v2.0",
  tonneCO2e:       ethers.parseEther("250"),  // 250 tonnes CO₂e
  vintageYear:     2031,                    // must be 2020–2100
  monitoringStart: startTimestamp,
  monitoringEnd:   endTimestamp,
  parcel: {
    geojsonHash:   parcelHash,             // same hash used in attestation
    centroidLat:   BigInt(-432000000),     // 7-decimal fixed-point (-4.32°)
    centroidLon:   BigInt(155000000),      // 7-decimal fixed-point (15.5°)
    areaHectares:  50000
  },
  attestation: {
    satelliteHash,
    reportHash,
    observationDate: BigInt(observationTimestamp),
    attestationDate: BigInt(attestationTimestamp)
  },
  status:           0,
  mintedAt:         0n,
  retiredAt:        0n,
  retiredBy:        ethers.ZeroAddress,
  retirementReason: ""
};

const tokenId = await registry.connect(government).mintCredit(credit, "0x");
```

---

## Section 7 — Register with the NCRI Index

The NCRI (Natural Carbon Reserve Index) aggregates all sovereign registries into a single global index. Connecting your registry makes your credits available to institutional funds purchasing diversified carbon baskets.

This step is performed by the CCR platform team after your registry passes audit. The following is for reference:

```js
// Called by CCR on the NCRI Hub chain
await ncriIndex.connect(governance).addNation(
  ethers.zeroPadBytes("0xCD", 2),            // your nation code
  "Democratic Republic of Congo",            // nation name
  await registry.getAddress(),               // registry address on your chain
  "channel-0"                                // IBC channel ID (assigned by CCR)
);

// The IBC relayer calls syncNationStats whenever NCRIStatsBroadcast is emitted.
// Your registry emits NCRIStatsBroadcast automatically on every mint, retire,
// suspend, and reinstate operation.
// You can also trigger a manual re-broadcast:
await registry.broadcastStats();
```

---

## Section 8 — Ongoing Operations

### Retiring a credit

```js
// Self-retirement (VOLUNTARY)
await registry.connect(tokenOwner).retireCredit(
  tokenId,
  "CORSIA Q3 2032 — SkyAirlines",
  0   // CompliancePurpose.VOLUNTARY
);

// On behalf of a named beneficiary (ITMO / Art. 6.2)
await registry.connect(broker).retireForBeneficiary(
  tokenId,
  "Art. 6.2 ITMO — NO-CD-2032",
  2,                    // CompliancePurpose.ARTICLE_6_2
  beneficiaryAddress,
  "Kingdom of Norway"
);
```

### Suspending a credit under investigation

```js
// Auditor (holds AUDITOR_ROLE)
await registry.connect(auditor).suspendCredit(tokenId);

// Government reinstates after investigation clears
await registry.connect(government).reinstateCredit(tokenId);
```

### Emergency pause

```js
// Pause all minting, transfers, and retirements
await registry.connect(government).pause();

// Resume
await registry.connect(government).unpause();
```

> `suspendCredit` and `reinstateCredit` are intentionally NOT blocked by pause — oversight must remain possible during emergency freezes.

### Replacing the oracle (timelock required)

```js
// Deploy new oracle, add auditors
const newOracle = await MRVOracle.deploy(government.address, 3);

// Propose (2-day wait required)
await registry.connect(government).proposeOracleUpdate(await newOracle.getAddress());

// Execute after ≥ 2 days
await registry.connect(government).executeOracleUpdate();
```

### Key rotation and recovery

If a government key is compromised:
1. Immediately call `registry.pause()` from the compromised key (if still possible) or use the backup multisig.
2. Call `registry.grantRole(REGISTRY_ADMIN, newGovernmentKey)`.
3. Call `registry.revokeRole(REGISTRY_ADMIN, compromisedKey)`.
4. Unpause.

All token ownership and retirement history is unaffected — the registry state is immutable.

---

## Quick-Reference: Key Contract Addresses

Fill in after deployment:

| Contract | Address | Network |
|----------|---------|---------|
| MRVOracle | `0x...` | |
| SovereignRegistry | `0x...` | |
| RetirementVault | `0x...` | |
| MethodologyRegistry | `0x...` | |
| NCRIIndex (Hub) | `0x...` | NCRI Hub |

---

## Appendix: Error Reference

| Error | Contract | Cause |
|-------|----------|-------|
| `AttestationNotFinalized` | SovereignRegistry | Fewer than `threshold` auditors have signed |
| `MintingCapExceeded` | SovereignRegistry | Batch would exceed the per-period cap |
| `WrongIssuingChain` | SovereignRegistry | `credit.issuingChainId` ≠ registry `nationCode` |
| `UnapprovedMethodology` | SovereignRegistry | Methodology not in MethodologyRegistry |
| `NotRetirable` | SovereignRegistry | Token is RETIRED or SUSPENDED |
| `TransferBlockedRetired` | SovereignRegistry | Retired tokens cannot be transferred |
| `TimelockNotExpired` | SovereignRegistry / MRVOracle | Proposal is less than 2 days old |
| `InsufficientRetirementFee` | RetirementVault | `msg.value` < `retirementFeeWei` |
| `WrongNation` | RetirementVault | Registry can only record its own nation's retirements |
| `NotInPool` | CarbonPool | Token is not deposited in the pool |
| `StatJumpTooLarge` | NCRIIndex | Relayer submitted stats jump > `maxStatJump` in one call |
