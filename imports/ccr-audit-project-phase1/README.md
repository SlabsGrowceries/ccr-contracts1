# CCR Carbon Credit Registry Audit Project

This project implements the CCR (Carbon Credit Registry) contracts as audited in the attached report.

## Contracts

- **MRVOracle.sol**: Multi-signature attestation oracle for carbon credit verification.
- **SovereignRegistry.sol**: ERC-721 registry for sovereign carbon credits with minting, retirement, and transfer controls.
- **RetirementVault.sol**: Immutable global ledger for credit retirements.
- **NCRIIndex.sol**: Multi-nation carbon index for supply balancing.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Compile contracts:
   ```bash
   npx hardhat compile
   ```

3. Run tests:
   ```bash
   npx hardhat test
   ```

## Test Suite

The test suite includes 50 assertions covering all contract logic as per the audit report.

## Security Notes

- Contracts use OpenZeppelin 5.6.1 for access control and ERC-721.
- Solidity 0.8.24 with viaIR and Cancun EVM.
- Advisory items from the audit are noted but not yet fixed in this implementation.

## Deployment

Deploy in order:
1. MRVOracle
2. SovereignRegistry (with oracle address)
3. RetirementVault
4. NCRIIndex

Grant appropriate roles after deployment.