// CCR Contract Verification Script — Etherscan / Sourcify
// Usage: npx hardhat run scripts/verify.js --network sepolia
//
// Reads the deployment addresses from deployments-sepolia.json (written by deploy.js)
// and verifies each contract on Etherscan so anyone can read the source code.
//
// Requires in .env:
//   ETHERSCAN_API_KEY=your_etherscan_api_key  (free at https://etherscan.io/myapikey)
//   GOVERNMENT_ADDRESS / CCR_OPERATOR_ADDRESS (same values used during deploy)

const hre = require("hardhat");
const fs  = require("fs");

async function main() {
  const network = hre.network.name;

  if (network === "hardhat" || network === "localhost") {
    console.error("Verification only works on live networks (sepolia).");
    process.exit(1);
  }

  const deploymentsFile = `deployments-${network}.json`;
  if (!fs.existsSync(deploymentsFile)) {
    console.error(`\nDeployment file not found: ${deploymentsFile}`);
    console.error("Run deploy.js first: npx hardhat run scripts/deploy.js --network sepolia");
    process.exit(1);
  }

  const d = JSON.parse(fs.readFileSync(deploymentsFile, "utf8"));
  const [deployer] = await hre.ethers.getSigners();

  console.log(`\n=== CCR Etherscan Verification — ${network.toUpperCase()} ===`);
  console.log(`Deployer:  ${deployer.address}`);
  console.log(`Loaded from: ${deploymentsFile}\n`);

  // ── 1. MRVOracle ───────────────────────────────────────
  console.log("1. Verifying MRVOracle...");
  await verify(d.MRVOracle, [
    deployer.address,  // admin
    3,                 // threshold
  ]);

  // ── 2. SovereignRegistry ───────────────────────────────
  console.log("2. Verifying SovereignRegistry...");
  await verify(d.SovereignRegistry, [
    d.roles.REGISTRY_ADMIN,
    d.roles.OPERATOR,
    d.MRVOracle,
    hre.ethers.zeroPadBytes("0xCD", 2),
    "Democratic Republic of Congo",
  ]);

  // ── 3. RetirementVault ─────────────────────────────────
  console.log("3. Verifying RetirementVault...");
  await verify(d.RetirementVault, [deployer.address]);

  // ── 4. NCRIIndex ───────────────────────────────────────
  console.log("4. Verifying NCRIIndex...");
  await verify(d.NCRIIndex, [deployer.address]);

  console.log("\n=== ALL CONTRACTS VERIFIED ===");
  console.log("View on Etherscan:");
  console.log(`  MRVOracle:          https://sepolia.etherscan.io/address/${d.MRVOracle}#code`);
  console.log(`  SovereignRegistry:  https://sepolia.etherscan.io/address/${d.SovereignRegistry}#code`);
  console.log(`  RetirementVault:    https://sepolia.etherscan.io/address/${d.RetirementVault}#code`);
  console.log(`  NCRIIndex:          https://sepolia.etherscan.io/address/${d.NCRIIndex}#code`);
}

async function verify(address, constructorArguments) {
  try {
    await hre.run("verify:verify", { address, constructorArguments });
    console.log(`   ✔ ${address}`);
  } catch (e) {
    if (e.message.includes("Already Verified") || e.message.includes("already verified")) {
      console.log(`   ✔ ${address} (already verified)`);
    } else {
      console.error(`   ✘ ${address}: ${e.message}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
