# Congo Carbon Reserve — Smart Contracts

Sovereign blockchain carbon credit registry for the Democratic Republic of Congo.
One CRS token = one verified tonne of CO₂ sequestered in DRC forests.

## Contracts

| Contract | Description |
|---|---|
| `MRVOracle.sol` | 3-of-5 auditor threshold multi-signature attestation |
| `SovereignRegistry.sol` | ERC-721 carbon credit token registry — government minting authority |
| `RetirementVault.sol` | Immutable global retirement ledger |
| `NCRIIndex.sol` | Natural Carbon Reserve Index — global sovereign carbon basket |
| `CRSToken.sol` | Shared data types (enums, structs) |

## Sepolia Testnet Deployment

| Contract | Address |
|---|---|
| MRVOracle | `0xe5a481F50ed775F71c7883B675f6e24078D70ba6` |
| SovereignRegistry (DRC) | `0x5B0a978029a61E932E46f099888f13f5dd616C8B` |
| RetirementVault | `0x054976A1772D37C697B87Aef61be3Ec9cccd097C` |
| NCRIIndex | `0xFFB8b34A3787d55B43e3ddC7582dD8319864eC70` |

Deployed: March 23, 2026. Source-verified on Sourcify.

## Sovereignty Guarantee

The DRC government wallet holds `REGISTRY_ADMIN` and `DEFAULT_ADMIN_ROLE`.
Only the government can mint credits. CCR holds `OPERATOR` only.
The government can call `revokeRole(OPERATOR, ccrAddress)` at any time —
CCR is removed instantly, all tokens remain valid. Enforced by code, not contract clauses.

## Setup

```bash
npm install
npx hardhat test              # 50 tests, all passing
npx hardhat run scripts/deploy.js                    # local
npx hardhat run scripts/deploy.js --network sepolia  # testnet
```

Requires Node.js v22+. Copy `.env.example` to `.env` and fill in your keys.

## Tests

```
50 passing (1s)
```

Covers: oracle threshold / fraud / dedup, mint validation, transfer blocking,
retirement, suspension/reinstatement, sovereignty revocation, vault duplicates,
NCRI deactivation/reactivation/rebalance.

## License

BUSL-1.1 — Business Source License. Not open for commercial use without CCR authorization.
