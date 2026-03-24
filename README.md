# Congo Carbon Reserve (CCR)

> **The world's first sovereign, science-gated, fully on-chain carbon credit registry.**
> One CRS token = one verified tonne of CO₂ sequestered in DRC forests — minted by the government, verified by independent auditors, retired permanently on-chain.

![Tests](https://img.shields.io/badge/tests-127%20passing-brightgreen)
![Solidity](https://img.shields.io/badge/solidity-0.8.24-blue)
![License](https://img.shields.io/badge/license-BUSL--1.1-orange)
![Audit Rounds](https://img.shields.io/badge/audit%20rounds-6-brightgreen)
![Critical Findings](https://img.shields.io/badge/critical%20findings-0-brightgreen)

---

## Why Every Other Carbon Platform Is Broken

The voluntary carbon market is a $2B market built on trust in PDFs. A company buys a "carbon credit" from a broker, receives a certificate, and posts it to their ESG report. There is no way to verify the forest exists, no way to confirm the tonne wasn't already sold to someone else, and no way to know if the government that issued the credit has since revoked it.

Blockchain carbon projects made this worse, not better:

- **Toucan Protocol** bridges Verra VCS credits onto Polygon. The bridge inherits all of Verra's off-chain trust assumptions. Toucan doesn't know if Verra's database was changed after the bridge. The token proves nothing except that someone ran a bridge script.
- **KlimaDAO** built a treasury on top of Toucan's bridged tokens. Its carbon reserves are as questionable as the underlying Toucan credits — with an additional layer of tokenomics volatility.
- **Moss.Earth** sells Amazon carbon credits as NFTs with no on-chain verification whatsoever. Purchase, receipt, and retirement all happen off-chain.
- **Regen Network** built a more credible system with on-chain methodology governance, but still relies on off-chain issuers and has no sovereign government as the registry admin. Their "Eco Credits" are issued by private organizations under community-voted methodologies — not sovereign law.
- **XRP Ledger (XRPL)** added a carbon marketplace to their built-in DEX. XRPL offers fast settlement, atomic swaps, and zero counter-party risk on trades. But the credits listed on XRPL are bridged from existing off-chain registries (Gold Standard, Verra). XRPL has no MRV oracle, no government registry admin, no immutable retirement ledger, and no double-spend proof. It is a fast exchange for certificates whose authenticity it cannot verify.

**CCR eliminates every one of these failure modes at the protocol level.**

---

## Full Competitive Analysis

| Feature | Toucan | KlimaDAO | Moss.Earth | Regen Network | XRP/XRPL | **CCR** |
|---|---|---|---|---|---|---|
| On-chain MRV verification | ❌ | ❌ | ❌ | Partial | ❌ | ✅ |
| Science-gated minting (multi-sig auditors) | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Government-sovereign registry | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Immutable double-spend proof | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Parcel boundary hash binding | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| 2-day admin timelocks | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Nation binding (registry ≠ cross-nation) | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Global sovereign index product | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Batch mint + batch retire | Partial | ❌ | ❌ | Partial | ❌ | ✅ |
| DeFi composable (ERC-20 wrapper) | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ |
| Monotonicity invariants on stats | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Typed custom errors (gas-efficient reverts) | ❌ | ❌ | ❌ | ❌ | N/A | ✅ |
| EVM compatible | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ |
| 0 critical audit findings | ✅ | ❌ | N/A | N/A | N/A | ✅ |

### Where CCR Outperforms XRP Specifically

XRP/XRPL is the most technically sophisticated competitor. Here is the exact gap:

| Dimension | XRP/XRPL | CCR |
|---|---|---|
| Settlement speed | 3–5 seconds | EVM block time (~12s) |
| Built-in DEX | ✅ native AMM | ✅ via CarbonPool → any AMM |
| MRV oracle | ❌ none | ✅ 3-of-5 auditor multi-sig |
| Who mints? | Bridged issuer (private) | Government (sovereign law) |
| Double-spend prevention | Trust issuer + XRPL ledger | On-chain `_alreadyRecorded` map |
| Credit authenticity | Off-chain registry trust | Parcel hash bound to auditor sigs |
| Retirement immutability | XRPL record (deletable by admin) | Append-only vault, structurally impossible to delete |
| Compliance reporting | Off-chain | `retiredByNation`, `retiredByPurpose`, `retiredByVintage` — queryable on-chain |

XRP wins on raw transaction speed. CCR wins on everything that matters for carbon market integrity.

---

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                        NATIONAL CHAIN (DRC)                     │
│                                                                  │
│  Satellite imagery + auditor reports                            │
│              ↓                                                   │
│      MRVOracle — 3-of-5 independent auditors sign              │
│              ↓                                                   │
│  SovereignRegistry — DRC government mints CRS NFT               │
│              ↓                                                   │
│  Buyer purchases → retires credit → token permanently locked    │
│              ↓                                                   │
│         NCRIStatsBroadcast event → IBC relayer                  │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                         NCRI HUB CHAIN                          │
│                                                                  │
│  RetirementVault — immutable global retirement ledger           │
│  NCRIIndex — sovereign carbon basket (the S&P 500 of carbon)   │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                            DEFI LAYER                           │
│                                                                  │
│  CarbonPool — ERC-20 wrapper for AMMs, lending, index funds    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Contracts

| Contract | Description |
|---|---|
| `MRVOracle.sol` | 3-of-5 auditor threshold multi-sig. Timelocked threshold changes. Parcel hash integrity. |
| `SovereignRegistry.sol` | ERC-721 carbon credit registry. Government-controlled minting. Batch mint/retire. 2-day timelocks. |
| `RetirementVault.sol` | Append-only global retirement ledger. Nation binding. CompliancePurpose enum. |
| `NCRIIndex.sol` | Sovereign carbon basket index. Monotonicity invariants. Dust-free rebalancing. |
| `CarbonPool.sol` | ERC-20 fungible wrapper. O(1) swap-and-pop queue. Vintage year filter. |
| `CRSToken.sol` | Shared data types: enums, structs. |

---

## Sovereignty Guarantee

The DRC government holds `REGISTRY_ADMIN` — the only role that can mint credits.
CCR holds `OPERATOR` only — infrastructure access, nothing more.

```solidity
// The government can remove CCR at any time with one transaction.
// All tokens remain valid. Enforced by code, not contract clauses.
registry.revokeRole(OPERATOR, ccrAddress);
```

This is the feature no other carbon platform offers. Toucan's bridge is controlled by Toucan. Regen's issuers are private organizations. XRP's marketplace is permissioned by Ripple Labs. In CCR, the sovereign government is the root of trust, and the code enforces it.

---

## Security

```
6 audit rounds  ·  0 critical  ·  0 high  ·  0 medium open
```

- **Science-gated minting** — 3-of-5 auditor threshold with `MIN_THRESHOLD = 3` floor that can never be lowered
- **Parcel hash integrity** — the credit's GPS boundary is cryptographically bound to auditor signatures; a tampered boundary fails verification
- **2-day timelocks** on oracle replacement, vault replacement, and threshold changes
- **Immutable retirement** — `RetirementVault` is append-only; double-counting is structurally impossible
- **Nation binding** — a registry authorised for Liberia cannot record a DRC retirement
- **Monotonicity invariants** — NCRIIndex rejects any relayer update that decreases historical minted or retired counts
- **CEI pattern** throughout — no reentrancy vectors, including inside `mintBatch` and `retireBatch` loops
- **Atomic batch operations** — a batch reverts entirely if any single credit fails validation; no partial state
- **Typed custom errors** — full parameterised error taxonomy across all 5 contracts

Full threat model, access control matrix, and invariants: [SECURITY.md](./SECURITY.md)

---

## Batch Operations

CCR supports institutional-scale operations that single-credit protocols cannot match:

```solidity
// Government mints 50 credits from one quarterly audit in a single transaction
uint256[] memory ids = registry.mintBatch(credits, "");

// Institutional buyer retires their entire CORSIA portfolio at once
registry.retireBatch(tokenIds, "CORSIA Q3 2032", CompliancePurpose.CORSIA);
```

This closes the gap with XRP/Toucan/Regen for high-throughput use cases while maintaining per-credit MRV validation and atomic rollback on any failure.

---

## Testnet Deployment (Sepolia)

| Contract | Address |
|---|---|
| MRVOracle | `0xe5a481F50ed775F71c7883B675f6e24078D70ba6` |
| SovereignRegistry (DRC) | `0x5B0a978029a61E932E46f099888f13f5dd616C8B` |
| RetirementVault | `0x054976A1772D37C697B87Aef61be3Ec9cccd097C` |
| NCRIIndex | `0xFFB8b34A3787d55B43e3ddC7582dD8319864eC70` |

Deployed March 23, 2026 · Source-verified on Sourcify.

---

## Getting Started

```bash
npm install
npx hardhat test                                     # 127 tests, all passing
npx hardhat run scripts/deploy.js                    # local
npx hardhat run scripts/deploy.js --network sepolia  # testnet
```

Requires Node.js v22+. Copy `.env.example` to `.env` and add your keys.

---

## Test Coverage

```
127 passing (3s)
```

| Area | Tests |
|---|---|
| MRV Oracle — threshold, fraud prevention, timelock, auditor management | 20 |
| SovereignRegistry — minting, transfer, retirement, suspension, listing, pause | 38 |
| SovereignRegistry — oracle timelock, vault timelock, parcel integrity | 20 |
| RetirementVault — recording, nation binding, CompliancePurpose, dedup | 14 |
| NCRIIndex — rebalance, deactivation, monotonicity, stats sync | 15 |
| CarbonPool — deposit, redeem, vintage filter, safeTransferFrom | 9 |
| Invariants + Round 4 findings | 11 |

All revert assertions use `.revertedWithCustomError()` — the modern Hardhat standard.

---

## License

BUSL-1.1 — Business Source License. Not open for commercial use without CCR authorization.
Contact the CCR team for partnership and licensing inquiries.
