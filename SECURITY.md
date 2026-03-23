# CCR Security Properties

> Intended audience: professional security auditors, institutional counterparties,
> and government partners reviewing the CCR contract system for deployment.

---

## 1. System Overview

CCR is a sovereign national carbon credit registry deployed as a suite of five Solidity
smart contracts. Each contract has a narrowly scoped responsibility:

| Contract | Chain | Responsibility |
|---|---|---|
| `MRVOracle` | National | Aggregates independent auditor attestations (3-of-N threshold multi-sig) |
| `SovereignRegistry` | National | ERC721 mint / retire / transfer authority — government-controlled |
| `RetirementVault` | NCRI Hub | Immutable append-only global offset ledger |
| `NCRIIndex` | NCRI Hub | Cross-national weighted index for institutional baskets |
| `CarbonPool` | Any | ERC20 fungible wrapper enabling DeFi composability |

---

## 2. Trust Hierarchy

```
Government (REGISTRY_ADMIN / DEFAULT_ADMIN_ROLE)
  └─ Owns the registry. Can eject CCR operator at any time with no timelock.
     Tokens remain valid after ejection. Enforced by code, not by contract.

MRV Auditors (AUDITOR_ROLE on MRVOracle)
  └─ 3-of-N threshold. No single auditor can finalize. Cannot mint tokens.
     Can suspend credits on SovereignRegistry.

CCR Operator (OPERATOR on SovereignRegistry)
  └─ Infrastructure management only. Cannot mint, burn, or modify credits.

IBC Relayer (RELAYER_ROLE on NCRIIndex)
  └─ Can only call syncNationStats with monotone values. Cannot alter weights.
     Any relayer failure leaves the last known state intact.
```

---

## 3. Access Control Matrix

| Action | Required Role | Contract |
|---|---|---|
| Mint credit | REGISTRY_ADMIN | SovereignRegistry |
| Retire credit | Token owner | SovereignRegistry |
| Suspend credit | AUDITOR_ROLE | SovereignRegistry |
| Reinstate credit | REGISTRY_ADMIN | SovereignRegistry |
| Propose oracle/vault update | REGISTRY_ADMIN | SovereignRegistry |
| Execute oracle/vault update | REGISTRY_ADMIN (after 2-day timelock) | SovereignRegistry |
| Add auditor to oracle | ADMIN_ROLE | MRVOracle |
| Remove auditor | ADMIN_ROLE (subject to threshold floor) | MRVOracle |
| Propose threshold change | ADMIN_ROLE | MRVOracle |
| Submit attestation | AUDITOR_ROLE | MRVOracle |
| Record retirement | REGISTRY_ROLE (per-nation binding) | RetirementVault |
| Add nation to index | GOVERNANCE_ROLE | NCRIIndex |
| Sync nation stats | RELAYER_ROLE | NCRIIndex |
| Deposit / redeem | Public | CarbonPool |

---

## 4. Security Invariants

The following invariants are enforced by code and covered by the test suite.

### MRVOracle
- `threshold >= MIN_THRESHOLD (3)` — permanently enforced; can never be lowered below 3
- `totalAuditors >= threshold` — enforced on both `removeAuditor` and `executeThreshold`
- `totalAuditors <= type(uint8).max` — overflow guard on `addAuditor`
- A single auditor cannot sign the same attestation twice (`ALREADY_SIGNED`)
- All auditors must agree on the same composite hash (satellite + report + parcel); any disagreement reverts with `HASH_MISMATCH`
- Threshold changes require a 2-day timelock; no pending proposal can override an active one (`PROPOSAL_PENDING`)

### SovereignRegistry
- A credit can only be minted after a finalized oracle attestation that matches the parcel boundary exactly (parcel fraud prevention)
- `serialId` is globally unique and permanently reserved after first use (`DUPLICATE_SERIAL`)
- `totalRetired + totalSuspended <= totalMinted` — implied by increment/decrement logic
- `totalActive() = totalMinted - totalRetired - totalSuspended`
- RETIRED tokens are permanently non-transferable (`TRANSFER_BLOCKED: token is retired`)
- SUSPENDED tokens are non-transferable until reinstated
- Oracle and vault replacements require a 2-day timelock with no pending-proposal override

### RetirementVault
- The ledger is append-only — no record can be deleted or modified
- Each `(nationCode, tokenId)` pair can only be recorded once (`ALREADY_RECORDED`)
- Each registry address is bound to exactly one nation — cross-nation writes are blocked (`WRONG_NATION`)
- `retiredByPurpose` is keyed by `CompliancePurpose` enum — no string fragmentation

### NCRIIndex
- `totalMinted` and `totalRetired` per nation are monotone — they can only increase (`MINTED_MUST_NOT_DECREASE`, `RETIRED_MUST_NOT_DECREASE`)
- `totalActive <= totalMinted` — enforced on `syncNationStats` (`ACTIVE_EXCEEDS_MINTED`)
- `sum(weights) == 10000` always when `globalActiveSupply > 0` — integer-division dust allocated to largest nation

---

## 5. Known-Safe Patterns

| Pattern | Where Applied |
|---|---|
| Checks-Effects-Interactions (CEI) | `mintCredit`, `retireCredit`, `CarbonPool.deposit`, `CarbonPool.redeem` |
| Reentrancy via `_safeMint` mitigated | State fully written before `_safeMint` in `mintCredit` |
| `try/catch` liveness guard | `retireCredit` → `vault.recordRetirement` — retirement never blocked by vault failure |
| Timelocked admin ops | Oracle update, vault update, threshold change — all 2-day delay |
| `PROPOSAL_PENDING` guard | All propose functions — prevents clock-reset griefing |
| Per-registry nation binding | `RetirementVault.registryNation` — prevents cross-nation poisoning |
| Composite hash parcel integrity | `MRVOracle.verifyAttestation` — parcel boundary must match what auditors signed |
| O(1) duplicate-signature detection | `_signerStatus[attestationId][auditor]` mapping |
| `uint8` overflow protection | `totalAuditors` bounded before increment |
| Monotonicity invariants | `syncNationStats` — prevents underflow on global aggregates |

---

## 6. External Dependencies

| Dependency | Version | Usage |
|---|---|---|
| OpenZeppelin Contracts | v5.x | ERC721, ERC20, AccessControl, Pausable, IERC721Receiver |
| Solidity | ^0.8.24 | Checked arithmetic, custom errors |
| EVM target | cancun | `mcopy` / `tload` available but not used |

All OpenZeppelin contracts are used without modification. No proxy pattern is employed —
contracts are immutable at deployment (upgradeability is via timelocked address replacement).

---

## 7. Known Limitations

1. **No ZK proof integration yet.** The `oracleProof` parameter in `mintCredit` and the
   `proof` parameter in `verifyAttestation` are reserved for Phase 2 ZK integration.
   Currently they accept but ignore arbitrary bytes.

2. **Cross-chain stats are push-based.** The `NCRIIndex` receives stats via an IBC relayer
   calling `syncNationStats`. Any relayer failure leaves the last known state intact.
   The `NCRIStatsBroadcast` event emitted by `SovereignRegistry` after every operation
   provides the authoritative feed for relayers to consume, and `broadcastStats()` allows
   anyone to re-emit the current state if an event was missed.

3. **`CarbonPool` does not protect against suspended-credit deadlock.** If all credits in a
   pool are suspended simultaneously, `redeem()` will revert for each. Users should check
   credit status before calling `redeem()`. The pool is not upgradeable — deployers should
   consider this edge case in product design.

4. **No professional third-party audit has been completed yet.** This document is intended
   to prepare the codebase for such an audit. The four internal audit rounds and 140+
   passing tests provide baseline assurance only.

---

## 8. Audit Scope

All files under `contracts/`:
- `CRSToken.sol` — data types only, no logic
- `MRVOracle.sol` — attestation aggregation
- `SovereignRegistry.sol` — ERC721 registry
- `RetirementVault.sol` — immutable ledger
- `NCRIIndex.sol` — cross-national index
- `CarbonPool.sol` — ERC20 pool wrapper

Test coverage is in `test/CCR.test.js`. Run with:
```bash
npx hardhat test
npx hardhat coverage
```

---

## 9. Disclosure

SPDX license: `BUSL-1.1` (Business Source License). Not open for commercial use without
a separate agreement with CCR. Security disclosures should be sent to the CCR security
contact before public disclosure.
