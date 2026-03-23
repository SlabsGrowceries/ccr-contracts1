# Congo Carbon Reserve (CCR)

> **The world's first sovereign, science-gated, fully on-chain carbon credit registry.**
> One CRS token = one verified tonne of CO₂ sequestered in DRC forests — minted by the government, verified by independent auditors, retired permanently on-chain.

![Tests](https://img.shields.io/badge/tests-127%20passing-brightgreen)
![Solidity](https://img.shields.io/badge/solidity-0.8.24-blue)
![License](https://img.shields.io/badge/license-BUSL--1.1-orange)
![Audit Rounds](https://img.shields.io/badge/audit%20rounds-6-brightgreen)
![Critical Findings](https://img.shields.io/badge/critical%20findings-0-brightgreen)

---

## Why CCR is Different

The carbon credit market is broken. Companies buy PDFs from brokers, trust that a forest exists, and have no way to verify that the same tonne wasn't sold twice. Existing blockchain carbon projects (Toucan, KlimaDAO, Moss) simply bridge existing registry credits onto-chain — they inherit all the same trust problems, they just add a token on top.

**CCR is built differently.**

| | Toucan Protocol | KlimaDAO | Moss.Earth | Regen Network | **CCR** |
|---|---|---|---|---|---|
| On-chain MRV verification | ❌ | ❌ | ❌ | Partial | ✅ |
| Science-gated minting (multi-sig auditors) | ❌ | ❌ | ❌ | ❌ | ✅ |
| Government-sovereign registry | ❌ | ❌ | ❌ | ❌ | ✅ |
| Immutable double-spend proof | ❌ | ❌ | ❌ | ❌ | ✅ |
| Global sovereign index product | ❌ | ❌ | ❌ | ❌ | ✅ |
| DeFi composable (ERC-20 wrapper) | ✅ | ✅ | ❌ | ❌ | ✅ |
| EVM compatible | ✅ | ✅ | ✅ | ❌ | ✅ |
| 0 critical audit findings | ✅ | ❌ | N/A | N/A | ✅ |

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
| `SovereignRegistry.sol` | ERC-721 carbon credit registry. Government-controlled minting. 2-day timelocks on all admin ops. |
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

No other carbon credit platform on any blockchain gives a sovereign government this level of control.

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
- **CEI pattern** throughout — no reentrancy vectors
- **Typed custom errors** — full parameterised error taxonomy across all 5 contracts

Full threat model, access control matrix, and invariants: [SECURITY.md](./SECURITY.md)

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
127 passing (2s)
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
