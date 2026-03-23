// CCR Deployment Script
// Local:   npx hardhat run scripts/deploy.js --network hardhat
// Testnet: npx hardhat run scripts/deploy.js --network sepolia

const hre = require("hardhat");

async function main() {
  const network = hre.network.name;
  const [deployer] = await hre.ethers.getSigners();

  console.log(`\n=== CCR Deployment — ${network.toUpperCase()} ===`);
  console.log("Deployer:", deployer.address);
  console.log("Balance: ", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH\n");

  // On testnet, roles come from .env. On local, use test signers.
  let governmentAddr, ccrOperatorAddr, oracleAdminAddr;
  if (network === "hardhat" || network === "localhost") {
    const signers = await hre.ethers.getSigners();
    governmentAddr  = signers[1].address;
    ccrOperatorAddr = signers[2].address;
    oracleAdminAddr = deployer.address;
  } else {
    if (!process.env.GOVERNMENT_ADDRESS)
      throw new Error("GOVERNMENT_ADDRESS env var required for non-local deployment");
    if (!process.env.CCR_OPERATOR_ADDRESS)
      throw new Error("CCR_OPERATOR_ADDRESS env var required for non-local deployment");
    governmentAddr  = process.env.GOVERNMENT_ADDRESS;
    ccrOperatorAddr = process.env.CCR_OPERATOR_ADDRESS;
    // Default oracle admin to government if not separately specified
    oracleAdminAddr = process.env.ORACLE_ADMIN_ADDRESS || governmentAddr;
  }

  console.log("Government (REGISTRY_ADMIN):", governmentAddr);
  console.log("CCR Operator:              ", ccrOperatorAddr);
  console.log("Oracle Admin:              ", oracleAdminAddr);

  // ── 1. MRV Oracle ──────────────────────────────────────
  process.stdout.write("\n1. Deploying MRVOracle... ");
  const MRVOracle = await hre.ethers.getContractFactory("MRVOracle");
  const oracle = await MRVOracle.deploy(oracleAdminAddr, 3);
  await oracle.waitForDeployment();
  const oracleAddr = await oracle.getAddress();
  console.log(oracleAddr);

  // ── 2. Sovereign Registry (DRC) ────────────────────────
  process.stdout.write("2. Deploying SovereignRegistry (DRC)... ");
  const SovereignRegistry = await hre.ethers.getContractFactory("SovereignRegistry");
  const registry = await SovereignRegistry.deploy(
    governmentAddr,
    ccrOperatorAddr,
    oracleAddr,
    hre.ethers.zeroPadBytes("0xCD", 2),
    "Democratic Republic of Congo"
  );
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.log(registryAddr);

  // ── 3. Retirement Vault ────────────────────────────────
  process.stdout.write("3. Deploying RetirementVault... ");
  const RetirementVault = await hre.ethers.getContractFactory("RetirementVault");
  // Deployer is vault admin during setup so it can call addRegistry.
  // Admin is handed off to government at the end of this block.
  const vault = await RetirementVault.deploy(deployer.address);
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  // addRegistry now takes (address, bytes2 nationCode) — M-01 fix
  await vault.addRegistry(registryAddr, hre.ethers.zeroPadBytes("0xCD", 2));
  // Hand vault admin roles to government; revoke deployer access
  const DEFAULT_ADMIN = await vault.DEFAULT_ADMIN_ROLE();
  const VAULT_ADMIN   = await vault.ADMIN_ROLE();
  await vault.grantRole(DEFAULT_ADMIN, governmentAddr);
  await vault.grantRole(VAULT_ADMIN,   governmentAddr);
  await vault.revokeRole(DEFAULT_ADMIN, deployer.address);
  await vault.revokeRole(VAULT_ADMIN,   deployer.address);
  console.log(vaultAddr);

  // ── 4. NCRI Index ──────────────────────────────────────
  process.stdout.write("4. Deploying NCRIIndex... ");
  const NCRIIndex = await hre.ethers.getContractFactory("NCRIIndex");
  const index = await NCRIIndex.deploy(deployer.address);
  await index.waitForDeployment();
  const indexAddr = await index.getAddress();
  await index.addNation(
    hre.ethers.zeroPadBytes("0xCD", 2),
    "Democratic Republic of Congo",
    registryAddr,
    "channel-0"
  );
  console.log(indexAddr);

  // ── Summary ────────────────────────────────────────────
  const summary = {
    network,
    deployedAt:       new Date().toISOString(),
    MRVOracle:        oracleAddr,
    SovereignRegistry: registryAddr,
    RetirementVault:  vaultAddr,
    NCRIIndex:        indexAddr,
    roles: {
      REGISTRY_ADMIN: governmentAddr,
      ORACLE_ADMIN:   oracleAdminAddr,
      OPERATOR:       ccrOperatorAddr,
      DEPLOYER:       deployer.address,
    },
  };

  console.log("\n=== DEPLOYMENT COMPLETE ===");
  console.log(JSON.stringify(summary, null, 2));

  // Save addresses to file for verification scripts
  const fs = require("fs");
  fs.writeFileSync(
    `deployments-${network}.json`,
    JSON.stringify(summary, null, 2)
  );
  console.log(`\nAddresses saved to deployments-${network}.json`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
