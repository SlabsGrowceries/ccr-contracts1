// CCR Gas Estimation Script
// Usage: npx hardhat run scripts/estimate-gas.js
//
// Deploys all contracts on the local Hardhat network and reports
// gas cost for each deployment at current Sepolia gas prices.
// Run this before deploying to testnet to know how much ETH you need.

const hre = require("hardhat");

// Sepolia gas price reference (gwei) — check https://sepolia.beaconcha.in for live prices
const SEPOLIA_GAS_PRICE_GWEI = 5;
// Sepolia ETH price reference (USD) — for USD cost estimate
const SEPOLIA_ETH_USD = 0;  // Sepolia ETH has no monetary value — just need gas units

async function main() {
  const [deployer, gov, operator] = await hre.ethers.getSigners();
  const gasPriceWei = BigInt(SEPOLIA_GAS_PRICE_GWEI) * BigInt(1e9);

  console.log("\n=== CCR Deployment Gas Estimate ===");
  console.log(`Gas price assumption: ${SEPOLIA_GAS_PRICE_GWEI} gwei\n`);

  let totalGas = 0n;

  // ── 1. MRVOracle ───────────────────────────────────────
  const MRVOracle = await hre.ethers.getContractFactory("MRVOracle");
  const oracleDeployTx = await MRVOracle.getDeployTransaction(deployer.address, 3);
  const oracleGas = await hre.ethers.provider.estimateGas(oracleDeployTx);
  totalGas += oracleGas;
  printRow("MRVOracle", oracleGas, gasPriceWei);

  // ── 2. SovereignRegistry ───────────────────────────────
  // Deploy oracle first so we have a real address for the constructor
  const oracle = await MRVOracle.deploy(deployer.address, 3);
  await oracle.waitForDeployment();
  const oracleAddr = await oracle.getAddress();

  const SovereignRegistry = await hre.ethers.getContractFactory("SovereignRegistry");
  const registryDeployTx = await SovereignRegistry.getDeployTransaction(
    gov.address,
    operator.address,
    oracleAddr,
    hre.ethers.zeroPadBytes("0xCD", 2),
    "Democratic Republic of Congo"
  );
  const registryGas = await hre.ethers.provider.estimateGas(registryDeployTx);
  totalGas += registryGas;
  printRow("SovereignRegistry", registryGas, gasPriceWei);

  // ── 3. RetirementVault ─────────────────────────────────
  const RetirementVault = await hre.ethers.getContractFactory("RetirementVault");
  const vaultDeployTx = await RetirementVault.getDeployTransaction(deployer.address);
  const vaultGas = await hre.ethers.provider.estimateGas(vaultDeployTx);
  totalGas += vaultGas;
  printRow("RetirementVault", vaultGas, gasPriceWei);

  // ── 4. NCRIIndex ───────────────────────────────────────
  const NCRIIndex = await hre.ethers.getContractFactory("NCRIIndex");
  const indexDeployTx = await NCRIIndex.getDeployTransaction(deployer.address);
  const indexGas = await hre.ethers.provider.estimateGas(indexDeployTx);
  totalGas += indexGas;
  printRow("NCRIIndex", indexGas, gasPriceWei);

  // ── Post-deploy setup calls ────────────────────────────
  // vault.addRegistry(registryAddr)
  const registry = await SovereignRegistry.deploy(
    gov.address, operator.address, oracleAddr,
    hre.ethers.zeroPadBytes("0xCD", 2), "Democratic Republic of Congo"
  );
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();

  const vault = await RetirementVault.deploy(deployer.address);
  await vault.waitForDeployment();
  const addRegistryGas = await vault.addRegistry.estimateGas(registryAddr);
  totalGas += addRegistryGas;
  printRow("vault.addRegistry()", addRegistryGas, gasPriceWei);

  // index.addNation(...)
  const index = await NCRIIndex.deploy(deployer.address);
  await index.waitForDeployment();
  const addNationGas = await index.addNation.estimateGas(
    hre.ethers.zeroPadBytes("0xCD", 2),
    "Democratic Republic of Congo",
    registryAddr,
    "channel-0"
  );
  totalGas += addNationGas;
  printRow("index.addNation(DRC)", addNationGas, gasPriceWei);

  // ── Summary ────────────────────────────────────────────
  const totalEth = hre.ethers.formatEther(totalGas * gasPriceWei);
  console.log("─".repeat(55));
  console.log(`TOTAL GAS:  ${totalGas.toLocaleString()} units`);
  console.log(`TOTAL COST: ${totalEth} ETH @ ${SEPOLIA_GAS_PRICE_GWEI} gwei`);
  console.log("\nRecommended Sepolia ETH to request from faucet: 0.5 ETH");
  console.log("Faucet: https://sepoliafaucet.com");
}

function printRow(label, gas, gasPriceWei) {
  const cost = hre.ethers.formatEther(gas * gasPriceWei);
  const padded = label.padEnd(25);
  console.log(`  ${padded}  ${gas.toLocaleString().padStart(10)} gas   (${cost} ETH)`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
