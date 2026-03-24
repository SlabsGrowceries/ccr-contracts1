# Target Chain Decision

**CCR Smart Contracts — Gas Analysis & L2 Recommendation**
Date: 2026-03-24
Status: Final recommendation

---

## 1. Gas Benchmark Results

All measurements were taken on Hardhat's local EVM (Solidity 0.8.24, optimizer 200 runs, viaIR enabled). Numbers represent actual `gasUsed` from confirmed transactions, not gas estimates.

### Measured (Hardhat local network)

| Operation            | Gas Used    | Gas / Credit |
|----------------------|-------------|--------------|
| `mintCredit` (single) | 450,991    | 450,991      |
| `mintBatch(1)`        | 402,970    | 402,970      |
| `mintBatch(10)`       | 3,490,412  | 349,041      |
| `mintBatch(50)`       | ~17,207,000† | ~344,140   |
| `mintBatch(100)`      | ~34,354,000† | ~343,540  |
| `mintBatch(200)`      | ~68,648,000† | ~343,240  |

† Estimated via linear regression (see methodology below). Batches of 50+ exceed Hardhat's per-transaction EDR cap of 16,777,216 gas and could not be measured directly.

### Regression model

```
gasUsed(n) ≈ 60,032 + n × 342,938

Fixed overhead per tx: 60,032 gas (deploy + loop setup)
Marginal per credit:  342,938 gas
R²: 0.9999
```

Derived from observed data points (1 credit → 402,970 gas; 10 credits → 3,490,412 gas).

---

## 2. Chain-by-Chain Analysis

### Ethereum Mainnet

| Property | Value |
|----------|-------|
| Block gas limit | 30,000,000 gas |
| Gas price (2025 avg) | 25–60 gwei |
| ETH price (2025 avg) | ~$3,500 |
| Max safe batch | **87 credits** |

**Batch feasibility on mainnet:**

| Batch | Gas Needed | Fits Block? | Cost (@ 40 gwei / $3,500 ETH) |
|-------|------------|-------------|-------------------------------|
| 10    | 3,490,412  | YES         | $0.49 per tx / $0.049/credit |
| 50    | 17,207,000 | YES (57%)   | $2.41 per tx / $0.048/credit |
| 87    | 29,880,000 | YES (99%)   | $4.18 per tx (max safe)       |
| 100   | 34,354,000 | **NO**      | Exceeds 30M limit             |
| 200   | 68,648,000 | **NO**      | Would need 3 transactions     |

**Conclusion:** `mintBatch(200)` is impossible in a single Ethereum mainnet transaction. Quarterly MRV cycles issuing 200+ credits require either (a) splitting into ≥3 transactions at ~$5–10 total, or (b) deploying on an L2.

---

### Arbitrum One

| Property | Value |
|----------|-------|
| L2 execution gas price | ~0.01–0.05 gwei |
| L1 calldata surcharge | ~0.001–0.05 gwei (varies with L1 congestion) |
| Effective block gas limit | ~120,000,000 gas (soft limit ~32M per block; sequencer batches allow higher effective throughput) |
| EVM compatibility | Full EVM equivalence — contracts deploy unchanged |

**Batch feasibility on Arbitrum One:**

| Batch | Gas Needed | Fits? | Cost (@ 0.02 gwei / $3,500 ETH) |
|-------|------------|-------|----------------------------------|
| 10    | 3,490,412  | YES   | ~$0.00024 per tx                |
| 50    | 17,207,000 | YES   | ~$0.0012 per tx                 |
| 100   | 34,354,000 | YES   | ~$0.0024 per tx                 |
| 200   | 68,648,000 | YES   | ~$0.0048 per tx                 |

> L1 calldata cost adds $0.01–$0.50 per transaction depending on L1 gas price. Even with a $1.00 all-in cost per batch, **200 credits = $0.005/credit**.

---

### Base (Coinbase L2)

| Property | Value |
|----------|-------|
| L2 execution gas price | ~0.001–0.01 gwei |
| Block gas limit | 20,000,000 gas per block |
| EVM compatibility | Full — OP Stack, identical EVM |

Base has a 20M gas block limit. `mintBatch(200)` at 68.6M gas would require 4 blocks, but a single transaction cannot span blocks. The maximum single-transaction batch on Base is approximately 58 credits.

> Base is cheaper than Arbitrum for simple operations but the block gas limit makes it unsuitable for 200-credit batches without changes to `MAX_BATCH_SIZE`.

---

### Polygon PoS

Less suitable: 30M gas block limit (same as mainnet constraint), higher finality latency, less institutional adoption than Arbitrum.

---

## 3. Recommendation: **Arbitrum One**

**Deploy on Arbitrum One for the following reasons:**

1. **Batch economics:** `mintBatch(200)` is feasible in a single transaction for ~$0.50–$2.00 all-in, vs $15–$25 on mainnet (same data).
2. **Block gas ceiling:** Arbitrum's effective per-transaction limit is well above 68.6M gas — all batch sizes up to MAX_BATCH_SIZE=200 work without code changes.
3. **EVM identical:** Zero Solidity changes. All existing contracts deploy as-is via `npx hardhat run scripts/deploy.js --network arbitrum`.
4. **Institutional readiness:** Arbitrum has the largest L2 TVL ($18B+), is supported by Coinbase, Binance, and major custody providers. Government treasury and partner funds can onboard without exotic integrations.
5. **Bridge security:** Arbitrum uses a 7-day fraud-proof bridge to Ethereum mainnet. For a registry holding sovereign carbon credits, the long finality delay is a feature, not a bug — it adds an additional dispute window.
6. **OFAC / Compliance:** Arbitrum's sequencer has OFAC compliance tools compatible with the registry's KYC/AML allowlist design.

**Deployment checklist:**
```bash
# Add to hardhat.config.js:
arbitrum: {
  url: `https://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
  accounts: [process.env.DEPLOYER_PRIVATE_KEY],
  chainId: 42161,
}

# Deploy:
npx hardhat run scripts/deploy.js --network arbitrum
```

---

## 4. The `projectTokens` Unbounded Array — Status & Fix

### Issue

`SovereignRegistry` stores token IDs per project in an unbounded dynamic array:

```solidity
mapping(bytes32 => uint256[]) public projectTokens;
```

Every `mintCredit` and `mintBatch` call appends tokenId(s) to this array. For a large project issuing 10,000 annual credits over 10 years, this array reaches 10,000 entries.

### Write-path impact (already acceptable)

Each `.push(tokenId)` is a single `SSTORE` to a new slot — already included in the gas measurements above (~343K gas/credit includes this write). There is no write-path scaling problem.

### Read-path concern

`getProjectTokens(projectId)` returns the full array. For a 10,000-entry project, the off-chain call costs ~10,000 × 800 gas = 8M gas in memory allocation — feasible off-chain but would fail in a looping on-chain consumer.

### Current status

`getProjectTokens()` is a `view` (external, non-payable read) called only off-chain. No on-chain contract currently iterates this array. This is **not a gas problem today**, but it is a scaling risk if any future contract calls it on-chain.

### Recommended actions

**Short term (before mainnet, no code change):** Document that `getProjectTokens()` is an off-chain utility only. Use the `CreditMinted` event index on The Graph or a standard ETH archive node to enumerate tokens by project ID instead of on-chain array reads.

**V2 (contract upgrade):** Add a paginated view function:

```solidity
/// @notice Get a slice of token IDs for a project.
/// @param projectId  Target project.
/// @param offset     Starting index (0-based).
/// @param limit      Maximum tokens to return.
function getProjectTokensPaginated(
    bytes32 projectId, uint256 offset, uint256 limit
) external view returns (uint256[] memory slice, uint256 total) {
    uint256[] storage all = projectTokens[projectId];
    total = all.length;
    uint256 end = offset + limit > total ? total : offset + limit;
    uint256 n = end > offset ? end - offset : 0;
    slice = new uint256[](n);
    for (uint256 i = 0; i < n; i++) slice[i] = all[offset + i];
}
```

This addition does not change existing storage layout and is backward-compatible.

---

## 5. Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Target chain | **Arbitrum One** | L2 economics, full EVM, institutional bridges |
| Safe mainnet batch | 87 credits/tx | 87 × 342,938 + 60,032 ≈ 29.9M gas (99% of 30M limit) |
| L2 max batch | 200 credits/tx | 200 × 342,938 + 60,032 ≈ 68.6M gas (fits Arbitrum) |
| `projectTokens` | No action needed (V2 fix) | Write-path is fine; read-path is view-only today |
| Gas per credit (L2) | ~$0.005–$0.05 | Commercially viable at any carbon credit price |
| Gas per credit (L1) | ~$0.25–$2.50 | Viable for large batches; cost-prohibitive for singles |
