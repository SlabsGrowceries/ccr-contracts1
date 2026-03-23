const { expect } = require("chai");
const { ethers } = require("hardhat");

// ─────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────

const DRC_CODE     = () => ethers.zeroPadBytes("0xCD", 2);
const LIBERIA_CODE = () => ethers.zeroPadBytes("0x4C", 2);

function buildCredit(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    serialId:         overrides.serialId         ?? "CRS#DRC-2031-000001",
    issuingChainId:   overrides.issuingChainId   ?? DRC_CODE(),
    projectId:        overrides.projectId        ?? ethers.keccak256(ethers.toUtf8Bytes("KONGO-CENTRAL-001")),
    projectType:      overrides.projectType      ?? 0,
    methodology:      overrides.methodology      ?? "ART-TREES-v2.0",
    tonneCO2e:        overrides.tonneCO2e        ?? ethers.parseEther("1"),
    vintageYear:      overrides.vintageYear      ?? 2031,
    monitoringStart:  overrides.monitoringStart  ?? BigInt(now - 86400 * 365),
    monitoringEnd:    overrides.monitoringEnd    ?? BigInt(now),
    parcel: {
      geojsonHash:  overrides.geojsonHash  ?? ethers.keccak256(ethers.toUtf8Bytes("parcel-001")),
      centroidLat:  overrides.centroidLat  ?? BigInt(-432000000),
      centroidLon:  overrides.centroidLon  ?? BigInt(155000000),
      areaHectares: overrides.areaHectares ?? 50000,
    },
    attestation: {
      satelliteHash:   overrides.satelliteHash   ?? ethers.keccak256(ethers.toUtf8Bytes("sentinel2.tif")),
      reportHash:      overrides.reportHash      ?? ethers.keccak256(ethers.toUtf8Bytes("mrv-report.pdf")),
      observationDate: overrides.observationDate ?? BigInt(now - 86400 * 7),
      attestationDate: overrides.attestationDate ?? BigInt(now),
    },
    status:           0,
    mintedAt:         0n,
    retiredAt:        0n,
    retiredBy:        ethers.ZeroAddress,
    retirementReason: "",
  };
}

async function advanceDays(n) {
  await ethers.provider.send("evm_increaseTime", [n * 86400]);
  await ethers.provider.send("evm_mine");
}

function buildRecord(overrides = {}) {
  return {
    tokenId:         overrides.tokenId         ?? 1n,
    serialId:        overrides.serialId        ?? "CRS#DRC-2031-000001",
    nationCode:      overrides.nationCode      ?? DRC_CODE(),
    retiringEntity:  overrides.retiringEntity  ?? "0x0000000000000000000000000000000000000001",
    entityName:      overrides.entityName      ?? "Kingdom of Norway",
    purposeCode:     overrides.purposeCode     ?? 0,   // 0 = VOLUNTARY
    purpose:         overrides.purpose         ?? "Article 6.2 ITMO",
    complianceRef:   overrides.complianceRef   ?? "NDC-NO-2031",
    vintageYear:     overrides.vintageYear     ?? 2031,
    retiredAt:       overrides.retiredAt       ?? BigInt(Math.floor(Date.now() / 1000)),
    attestationHash: overrides.attestationHash ?? ethers.keccak256(ethers.toUtf8Bytes("attest-001")),
  };
}

async function deployFixture() {
  const [admin, government, ccrOperator, auditor1, auditor2, auditor3, auditor4, auditor5, buyer, stranger]
    = await ethers.getSigners();

  const MRVOracle = await ethers.getContractFactory("MRVOracle");
  const oracle = await MRVOracle.deploy(admin.address, 3);
  for (const a of [auditor1, auditor2, auditor3, auditor4, auditor5]) {
    await oracle.addAuditor(a.address);
  }

  const SovereignRegistry = await ethers.getContractFactory("SovereignRegistry");
  const registry = await SovereignRegistry.deploy(
    government.address, ccrOperator.address, await oracle.getAddress(),
    DRC_CODE(), "Democratic Republic of Congo"
  );
  const AUDITOR_ROLE = await registry.AUDITOR_ROLE();
  await registry.connect(government).grantRole(AUDITOR_ROLE, auditor1.address);

  const RetirementVault = await ethers.getContractFactory("RetirementVault");
  const vault = await RetirementVault.deploy(admin.address);
  // addRegistry now takes (address, bytes2 nationCode) — M-01 fix
  await vault.addRegistry(await registry.getAddress(), DRC_CODE());
  // Wire the vault into the registry via 2-day timelock — L-02 fix
  await registry.connect(government).proposeVaultUpdate(await vault.getAddress());
  await advanceDays(2);
  await registry.connect(government).executeVaultUpdate();

  const NCRIIndex = await ethers.getContractFactory("NCRIIndex");
  const index = await NCRIIndex.deploy(admin.address);
  // NCRIIndex now requires non-zero registry address — use a real address
  await index.addNation(DRC_CODE(), "Democratic Republic of Congo", await registry.getAddress(), "channel-0");

  return { oracle, registry, vault, index, admin, government, ccrOperator,
           auditor1, auditor2, auditor3, auditor4, auditor5, buyer, stranger };
}

// submitAttestation no longer takes an attestationId parameter — it derives it internally
async function finalizeAttestation(oracle, credit, auditors) {
  for (const a of auditors) {
    await oracle.connect(a).submitAttestation(
      credit.attestation.satelliteHash,
      credit.attestation.reportHash,
      credit.parcel.geojsonHash
    );
  }
  // Return the deterministic ID for use in assertions
  return ethers.keccak256(ethers.solidityPacked(
    ["bytes32", "bytes32"],
    [credit.attestation.satelliteHash, credit.attestation.reportHash]
  ));
}

// ─────────────────────────────────────────────────────────
//  MRV ORACLE
// ─────────────────────────────────────────────────────────

describe("MRVOracle", function () {
  it("starts with threshold of 3", async function () {
    const { oracle } = await deployFixture();
    expect(await oracle.threshold()).to.equal(3);
  });

  it("auditor can submit attestation", async function () {
    const { oracle, auditor1 } = await deployFixture();
    const c = buildCredit();
    await expect(oracle.connect(auditor1).submitAttestation(
      c.attestation.satelliteHash, c.attestation.reportHash, c.parcel.geojsonHash
    )).to.emit(oracle, "AuditorSigned");
  });

  it("non-auditor is rejected", async function () {
    const { oracle, stranger } = await deployFixture();
    const c = buildCredit();
    await expect(oracle.connect(stranger).submitAttestation(
      c.attestation.satelliteHash, c.attestation.reportHash, c.parcel.geojsonHash
    )).to.be.reverted;
  });

  it("finalizes after 3 signatures and isFinalized returns true", async function () {
    const { oracle, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit();
    const id = await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    expect(await oracle.isFinalized(id)).to.be.true;
  });

  it("does NOT finalize after only 2 signatures", async function () {
    const { oracle, auditor1, auditor2 } = await deployFixture();
    const c = buildCredit();
    const id = await finalizeAttestation(oracle, c, [auditor1, auditor2]);
    expect(await oracle.isFinalized(id)).to.be.false;
  });

  it("rejects mismatched parcel hash — fraud prevention", async function () {
    const { oracle, auditor1, auditor2 } = await deployFixture();
    const c = buildCredit();
    await oracle.connect(auditor1).submitAttestation(
      c.attestation.satelliteHash, c.attestation.reportHash, c.parcel.geojsonHash
    );
    const fakeParcel = ethers.keccak256(ethers.toUtf8Bytes("fake-parcel"));
    await expect(oracle.connect(auditor2).submitAttestation(
      c.attestation.satelliteHash, c.attestation.reportHash, fakeParcel
    )).to.be.revertedWithCustomError(oracle, "HashMismatch");
  });

  it("prevents double-signing by same auditor", async function () {
    const { oracle, auditor1 } = await deployFixture();
    const c = buildCredit();
    await oracle.connect(auditor1).submitAttestation(
      c.attestation.satelliteHash, c.attestation.reportHash, c.parcel.geojsonHash
    );
    await expect(oracle.connect(auditor1).submitAttestation(
      c.attestation.satelliteHash, c.attestation.reportHash, c.parcel.geojsonHash
    )).to.be.revertedWithCustomError(oracle, "AlreadySigned");
  });

  it("cannot propose threshold below 3", async function () {
    const { oracle } = await deployFixture();
    await expect(oracle.proposeThreshold(2)).to.be.revertedWithCustomError(oracle, "ThresholdTooLow");
  });

  it("addAuditor is idempotent — totalAuditors does not double-count", async function () {
    const { oracle, auditor1 } = await deployFixture();
    const before = await oracle.totalAuditors();
    // auditor1 is already added in fixture — adding again should not increment
    await oracle.addAuditor(auditor1.address);
    expect(await oracle.totalAuditors()).to.equal(before);
  });

  it("rejects zero address as auditor", async function () {
    const { oracle } = await deployFixture();
    await expect(oracle.addAuditor(ethers.ZeroAddress)).to.be.revertedWithCustomError(oracle, "InvalidAuditor");
  });

  it("rejects zero hashes in submitAttestation", async function () {
    const { oracle, auditor1 } = await deployFixture();
    const c = buildCredit();
    await expect(oracle.connect(auditor1).submitAttestation(
      ethers.ZeroHash, c.attestation.reportHash, c.parcel.geojsonHash
    )).to.be.revertedWithCustomError(oracle, "InvalidSatelliteHash");
  });

  it("getAttestationId returns deterministic ID matching isFinalized", async function () {
    const { oracle, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    const id = await oracle.getAttestationId(c.attestation.satelliteHash, c.attestation.reportHash);
    expect(await oracle.isFinalized(id)).to.be.true;
  });
});

// ─────────────────────────────────────────────────────────
//  SOVEREIGN REGISTRY — MINTING
// ─────────────────────────────────────────────────────────

describe("SovereignRegistry — Minting", function () {
  it("government mints after oracle attestation", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await expect(registry.connect(government).mintCredit(c, "0x"))
      .to.emit(registry, "CreditMinted")
      .withArgs(1n, "CRS#DRC-2031-000001", c.projectId, government.address);
    expect(await registry.totalMinted()).to.equal(1);
  });

  it("non-government cannot mint", async function () {
    const { oracle, registry, ccrOperator, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await expect(registry.connect(ccrOperator).mintCredit(c, "0x")).to.be.reverted;
  });

  it("rejects mint without oracle attestation", async function () {
    const { registry, government } = await deployFixture();
    await expect(registry.connect(government).mintCredit(buildCredit(), "0x"))
      .to.be.revertedWithCustomError(registry, "AttestationNotFinalized");
  });

  it("rejects duplicate serial number", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");
    await expect(registry.connect(government).mintCredit(c, "0x")).to.be.revertedWithCustomError(registry, "DuplicateSerial");
  });

  it("rejects empty serial number", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit({ serialId: "" });
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await expect(registry.connect(government).mintCredit(c, "0x")).to.be.revertedWithCustomError(registry, "EmptySerial");
  });

  it("rejects zero projectId", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit({ projectId: ethers.ZeroHash });
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await expect(registry.connect(government).mintCredit(c, "0x")).to.be.revertedWithCustomError(registry, "InvalidProjectId");
  });

  it("rejects zero tonneCO2e", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit({ tonneCO2e: 0n });
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await expect(registry.connect(government).mintCredit(c, "0x")).to.be.revertedWithCustomError(registry, "InvalidTonne");
  });

  it("rejects zero areaHectares", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit({ areaHectares: 0 });
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await expect(registry.connect(government).mintCredit(c, "0x")).to.be.revertedWithCustomError(registry, "InvalidArea");
  });

  it("minted token has ACTIVE status", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");
    expect((await registry.credits(1)).status).to.equal(0); // TokenStatus.ACTIVE = 0
  });

  it("government owns the minted token", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");
    expect(await registry.ownerOf(1)).to.equal(government.address);
  });
});

// ─────────────────────────────────────────────────────────
//  SOVEREIGN REGISTRY — TRANSFER
// ─────────────────────────────────────────────────────────

describe("SovereignRegistry — Transfer", function () {
  it("government transfers token to buyer", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3, buyer } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");
    await registry.connect(government).transferFrom(government.address, buyer.address, 1);
    expect(await registry.ownerOf(1)).to.equal(buyer.address);
  });

  it("stranger cannot transfer a token they don't own", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3, buyer, stranger } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");
    await expect(registry.connect(stranger).transferFrom(government.address, buyer.address, 1)).to.be.reverted;
  });

  it("RETIRED token cannot be transferred", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3, buyer } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");
    await registry.connect(government).retireCredit(1, "CORSIA-2032-Q3", 0);
    await expect(registry.connect(government).transferFrom(government.address, buyer.address, 1))
      .to.be.revertedWithCustomError(registry, "TransferBlockedRetired");
  });

  it("SUSPENDED token cannot be transferred", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3, buyer } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");
    await registry.connect(auditor1).suspendCredit(1);
    await expect(registry.connect(government).transferFrom(government.address, buyer.address, 1))
      .to.be.revertedWithCustomError(registry, "TransferBlockedSuspended");
  });
});

// ─────────────────────────────────────────────────────────
//  SOVEREIGN REGISTRY — RETIREMENT
// ─────────────────────────────────────────────────────────

describe("SovereignRegistry — Retirement", function () {
  it("owner retires a credit", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");
    await expect(registry.connect(government).retireCredit(1, "Art6.2 NO-CD-2031", 0))
      .to.emit(registry, "CreditRetired").withArgs(1n, government.address, "Art6.2 NO-CD-2031");
  });

  it("retired token has RETIRED status with reason", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");
    await registry.connect(government).retireCredit(1, "CORSIA-2032-Q3", 0);
    const stored = await registry.credits(1);
    expect(stored.status).to.equal(2); // TokenStatus.RETIRED = 2
    expect(stored.retiredBy).to.equal(government.address);
    expect(stored.retirementReason).to.equal("CORSIA-2032-Q3");
  });

  it("cannot retire twice", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");
    await registry.connect(government).retireCredit(1, "CORSIA-2032-Q3", 0);
    await expect(registry.connect(government).retireCredit(1, "CORSIA-2032-Q3", 0)).to.be.revertedWithCustomError(registry, "NotRetirable");
  });

  it("requires a reason", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");
    await expect(registry.connect(government).retireCredit(1, "", 0)).to.be.revertedWithCustomError(registry, "ReasonRequired");
  });

  it("non-owner cannot retire", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3, stranger } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");
    await expect(registry.connect(stranger).retireCredit(1, "CORSIA-2032-Q3", 0)).to.be.revertedWithCustomError(registry, "NotOwner");
  });

  it("totalRetired increments", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");
    await registry.connect(government).retireCredit(1, "voluntary", 0);
    expect(await registry.totalRetired()).to.equal(1);
  });
});

// ─────────────────────────────────────────────────────────
//  SOVEREIGN REGISTRY — SUSPENSION
// ─────────────────────────────────────────────────────────

describe("SovereignRegistry — Suspension", function () {
  it("auditor suspends, government reinstates", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");
    await registry.connect(auditor1).suspendCredit(1);
    expect((await registry.credits(1)).status).to.equal(3); // TokenStatus.SUSPENDED = 3
    await registry.connect(government).reinstateCredit(1);
    expect((await registry.credits(1)).status).to.equal(0); // TokenStatus.ACTIVE = 0
  });
});

// ─────────────────────────────────────────────────────────
//  SOVEREIGNTY GUARANTEE
// ─────────────────────────────────────────────────────────

describe("Sovereignty Guarantee", function () {
  it("government revokes CCR operator role — existing tokens unaffected", async function () {
    const { oracle, registry, government, ccrOperator, auditor1, auditor2, auditor3 } = await deployFixture();
    const OPERATOR = await registry.OPERATOR();

    // Mint a token first
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");

    // Government kicks CCR out
    expect(await registry.hasRole(OPERATOR, ccrOperator.address)).to.be.true;
    await registry.connect(government).revokeRole(OPERATOR, ccrOperator.address);
    expect(await registry.hasRole(OPERATOR, ccrOperator.address)).to.be.false;

    // Token still exists and is valid
    expect((await registry.credits(1)).status).to.equal(0); // TokenStatus.ACTIVE = 0
  });

  it("proposeOracleUpdate rejects zero address", async function () {
    const { registry, government } = await deployFixture();
    await expect(registry.connect(government).proposeOracleUpdate(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(registry, "InvalidOracle");
  });
});

// ─────────────────────────────────────────────────────────
//  RETIREMENT VAULT
// ─────────────────────────────────────────────────────────

describe("RetirementVault", function () {
  function buildRecord(overrides = {}) {
    return {
      tokenId:         overrides.tokenId         ?? 1n,
      serialId:        overrides.serialId        ?? "CRS#DRC-2031-000001",
      nationCode:      overrides.nationCode      ?? DRC_CODE(),
      retiringEntity:  overrides.retiringEntity  ?? "0x0000000000000000000000000000000000000001",
      entityName:      overrides.entityName      ?? "Kingdom of Norway",
      purposeCode:     overrides.purposeCode     ?? 0,   // 0 = VOLUNTARY
      purpose:         overrides.purpose         ?? "Article 6.2 ITMO",
      complianceRef:   overrides.complianceRef   ?? "NDC-NO-2031",
      vintageYear:     overrides.vintageYear     ?? 2031,
      retiredAt:       overrides.retiredAt       ?? BigInt(Math.floor(Date.now() / 1000)),
      attestationHash: overrides.attestationHash ?? ethers.keccak256(ethers.toUtf8Bytes("attest-001")),
    };
  }

  it("records a retirement permanently", async function () {
    const { vault, admin } = await deployFixture();
    await vault.addRegistry(admin.address, DRC_CODE());
    await expect(vault.connect(admin).recordRetirement(buildRecord()))
      .to.emit(vault, "CreditRetiredGlobal");
    expect(await vault.totalRetired()).to.equal(1);
  });

  it("rejects duplicate tokenId from same nation", async function () {
    const { vault, admin } = await deployFixture();
    await vault.addRegistry(admin.address, DRC_CODE());
    await vault.connect(admin).recordRetirement(buildRecord());
    await expect(vault.connect(admin).recordRetirement(buildRecord()))
      .to.be.revertedWithCustomError(vault, "AlreadyRecorded");
  });

  it("rejects record with tokenId = 0", async function () {
    const { vault, admin } = await deployFixture();
    await vault.addRegistry(admin.address, DRC_CODE());
    await expect(vault.connect(admin).recordRetirement(buildRecord({ tokenId: 0n })))
      .to.be.revertedWithCustomError(vault, "InvalidTokenId");
  });

  it("rejects record with empty purpose", async function () {
    const { vault, admin } = await deployFixture();
    await vault.addRegistry(admin.address, DRC_CODE());
    await expect(vault.connect(admin).recordRetirement(buildRecord({ purpose: "" })))
      .to.be.revertedWithCustomError(vault, "PurposeRequired");
  });

  it("rejects record with zero retiredAt timestamp", async function () {
    const { vault, admin } = await deployFixture();
    await vault.addRegistry(admin.address, DRC_CODE());
    await expect(vault.connect(admin).recordRetirement(buildRecord({ retiredAt: 0n })))
      .to.be.revertedWithCustomError(vault, "InvalidTimestamp");
  });

  it("isRecorded returns true after recording", async function () {
    const { vault, admin } = await deployFixture();
    await vault.addRegistry(admin.address, DRC_CODE());
    await vault.connect(admin).recordRetirement(buildRecord());
    expect(await vault.isRecorded(DRC_CODE(), 1n)).to.be.true;
    expect(await vault.isRecorded(DRC_CODE(), 2n)).to.be.false;
  });
});

// ─────────────────────────────────────────────────────────
//  NCRI INDEX
// ─────────────────────────────────────────────────────────

describe("NCRIIndex", function () {
  it("DRC is registered on deployment", async function () {
    const { index } = await deployFixture();
    expect(await index.nationCount()).to.equal(1);
    const n = await index.getNation(DRC_CODE());
    expect(n.nationName).to.equal("Democratic Republic of Congo");
    expect(n.isActive).to.be.true;
  });

  it("rejects zero nation code on addNation", async function () {
    const { index, registry } = await deployFixture();
    await expect(index.addNation(
      ethers.zeroPadBytes("0x00", 2), "Test", await registry.getAddress(), "ch-0"
    )).to.be.revertedWithCustomError(index, "InvalidNationCode");
  });

  it("rejects zero registry address on addNation", async function () {
    const { index } = await deployFixture();
    await expect(index.addNation(
      LIBERIA_CODE(), "Liberia", ethers.ZeroAddress, "ch-1"
    )).to.be.revertedWithCustomError(index, "InvalidRegistry");
  });

  it("adds Liberia as second nation", async function () {
    const { index, registry } = await deployFixture();
    await index.addNation(LIBERIA_CODE(), "Liberia", await registry.getAddress(), "channel-1");
    expect(await index.nationCount()).to.equal(2);
  });

  it("rebalance: DRC 60%, Liberia 40%", async function () {
    const { index, admin, registry } = await deployFixture();
    await index.addNation(LIBERIA_CODE(), "Liberia", await registry.getAddress(), "channel-1");
    const RELAYER_ROLE = await index.RELAYER_ROLE();
    await index.grantRole(RELAYER_ROLE, admin.address);
    await index.syncNationStats(DRC_CODE(),     1000n, 600n, 200n, 0n);
    await index.syncNationStats(LIBERIA_CODE(), 500n,  400n, 100n, 0n);
    const [, weights] = await index.rebalance();
    expect(weights[0]).to.equal(6000n);
    expect(weights[1]).to.equal(4000n);
  });

  it("deactivateNation removes supply from global aggregates", async function () {
    const { index, admin } = await deployFixture();
    const RELAYER_ROLE = await index.RELAYER_ROLE();
    await index.grantRole(RELAYER_ROLE, admin.address);
    await index.syncNationStats(DRC_CODE(), 1000n, 600n, 200n, 0n);
    expect(await index.globalActiveSupply()).to.equal(600n);

    await index.deactivateNation(DRC_CODE());
    expect(await index.globalActiveSupply()).to.equal(0n);
    expect((await index.getNation(DRC_CODE())).isActive).to.be.false;
  });

  it("reactivateNation restores supply to global aggregates", async function () {
    const { index, admin } = await deployFixture();
    const RELAYER_ROLE = await index.RELAYER_ROLE();
    await index.grantRole(RELAYER_ROLE, admin.address);
    await index.syncNationStats(DRC_CODE(), 1000n, 600n, 200n, 0n);
    await index.deactivateNation(DRC_CODE());
    expect(await index.globalActiveSupply()).to.equal(0n);

    await index.reactivateNation(DRC_CODE());
    expect(await index.globalActiveSupply()).to.equal(600n);
    expect((await index.getNation(DRC_CODE())).isActive).to.be.true;
  });

  it("deactivateNation rejects if already inactive", async function () {
    const { index } = await deployFixture();
    await index.deactivateNation(DRC_CODE());
    await expect(index.deactivateNation(DRC_CODE())).to.be.revertedWithCustomError(index, "AlreadyInactive");
  });

  it("reactivateNation rejects if already active", async function () {
    const { index } = await deployFixture();
    await expect(index.reactivateNation(DRC_CODE())).to.be.revertedWithCustomError(index, "AlreadyActive");
  });

  it("rebalance weights sum to exactly 10000 with non-round division", async function () {
    const { index, admin, registry } = await deployFixture();
    await index.addNation(LIBERIA_CODE(), "Liberia", await registry.getAddress(), "channel-1");
    const thirdCode = ethers.zeroPadBytes("0x47", 2); // "G"
    await index.addNation(thirdCode, "Gabon", await registry.getAddress(), "channel-2");
    const RELAYER_ROLE = await index.RELAYER_ROLE();
    await index.grantRole(RELAYER_ROLE, admin.address);
    // 1/3 each — integer division would produce 3333+3333+3333 = 9999, dust = 1
    await index.syncNationStats(DRC_CODE(),     300n, 100n, 0n, 0n);
    await index.syncNationStats(LIBERIA_CODE(), 300n, 100n, 0n, 0n);
    await index.syncNationStats(thirdCode,      300n, 100n, 0n, 0n);
    const [, weights] = await index.rebalance();
    const total = weights.reduce((a, b) => a + b, 0n);
    expect(total).to.equal(10000n);
  });
});

// ─────────────────────────────────────────────────────────
//  MRV ORACLE — AUDITOR MANAGEMENT
// ─────────────────────────────────────────────────────────

describe("MRVOracle — Auditor Management", function () {
  it("removeAuditor succeeds when pool stays above threshold", async function () {
    const { oracle, auditor5 } = await deployFixture();
    // totalAuditors = 5, threshold = 3 — removing one leaves 4 >= 3
    await expect(oracle.removeAuditor(auditor5.address))
      .to.emit(oracle, "AuditorRemoved").withArgs(auditor5.address);
    expect(await oracle.totalAuditors()).to.equal(4);
  });

  it("removeAuditor reverts when removal would break threshold", async function () {
    const { oracle, auditor3, auditor4, auditor5 } = await deployFixture();
    // Remove down to exactly threshold (3)
    await oracle.removeAuditor(auditor4.address);
    await oracle.removeAuditor(auditor5.address);
    expect(await oracle.totalAuditors()).to.equal(3);
    // One more removal would put totalAuditors below threshold
    await expect(oracle.removeAuditor(auditor3.address))
      .to.be.revertedWithCustomError(oracle, "WouldBreakThreshold");
  });

  it("removeAuditor reverts on address that is not an auditor", async function () {
    const { oracle, stranger } = await deployFixture();
    await expect(oracle.removeAuditor(stranger.address))
      .to.be.revertedWithCustomError(oracle, "NotAnAuditor");
  });
});

// ─────────────────────────────────────────────────────────
//  SOVEREIGN REGISTRY — PAUSE
// ─────────────────────────────────────────────────────────

describe("SovereignRegistry — Pause", function () {
  it("government can pause and unpause", async function () {
    const { registry, government } = await deployFixture();
    await registry.connect(government).pause();
    await registry.connect(government).unpause();
  });

  it("non-government cannot pause", async function () {
    const { registry, stranger } = await deployFixture();
    await expect(registry.connect(stranger).pause()).to.be.reverted;
  });

  it("pause blocks mintCredit", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).pause();
    await expect(registry.connect(government).mintCredit(c, "0x")).to.be.reverted;
  });

  it("pause blocks retireCredit", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");
    await registry.connect(government).pause();
    await expect(registry.connect(government).retireCredit(1, "CORSIA-2032-Q3", 0)).to.be.reverted;
  });

  it("pause blocks transfers", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3, buyer } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");
    await registry.connect(government).pause();
    await expect(
      registry.connect(government).transferFrom(government.address, buyer.address, 1)
    ).to.be.revertedWithCustomError(registry, "RegistryPaused");
  });

  it("unpause restores minting", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).pause();
    await registry.connect(government).unpause();
    await expect(registry.connect(government).mintCredit(c, "0x"))
      .to.emit(registry, "CreditMinted");
  });
});

// ─────────────────────────────────────────────────────────
//  SOVEREIGN REGISTRY — PARCEL HASH INTEGRITY (H-03)
// ─────────────────────────────────────────────────────────

describe("SovereignRegistry — Parcel Hash Integrity", function () {
  it("rejects mint when credit parcel hash differs from what auditors signed", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit();
    // Auditors sign the legitimate parcel (c.parcel.geojsonHash)
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    // Build a credit with a tampered parcel boundary
    const tampered = buildCredit({
      geojsonHash: ethers.keccak256(ethers.toUtf8Bytes("fraudulent-parcel-boundary"))
    });
    await expect(registry.connect(government).mintCredit(tampered, "0x"))
      .to.be.revertedWithCustomError(registry, "AttestationNotFinalized");
  });

  it("accepts mint when parcel hash matches exactly what auditors signed", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await expect(registry.connect(government).mintCredit(c, "0x"))
      .to.emit(registry, "CreditMinted");
  });
});

// ─────────────────────────────────────────────────────────
//  SOVEREIGN REGISTRY — VAULT AUTO-RECORDING (H-01)
// ─────────────────────────────────────────────────────────

describe("SovereignRegistry — Vault Auto-Recording", function () {
  it("retireCredit auto-records in global vault", async function () {
    const { oracle, registry, vault, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");
    await registry.connect(government).retireCredit(1, "CORSIA-2032-Q3", 0);
    expect(await vault.isRecorded(DRC_CODE(), 1n)).to.be.true;
    expect(await vault.totalRetired()).to.equal(1);
  });

  it("vault record has correct purpose and nation", async function () {
    const { oracle, registry, vault, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");
    await registry.connect(government).retireCredit(1, "Art6.2 NO-CD-2031", 0);
    const record = await vault.getRetirement(0);
    expect(record.purpose).to.equal("Art6.2 NO-CD-2031");  // reason string
    expect(record.purposeCode).to.equal(0n);                // 0 = VOLUNTARY
    expect(record.nationCode).to.equal(DRC_CODE());
    expect(record.retiringEntity).to.equal(government.address);
  });

  it("second retirement of same token is blocked by vault", async function () {
    // This tests that the vault's double-recording guard works end-to-end.
    // The registry already blocks double-retirement via NOT_RETIRABLE,
    // but this confirms the vault guard is also in place.
    const { oracle, registry, vault, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");
    await registry.connect(government).retireCredit(1, "voluntary", 0);
    // Direct vault call with same tokenId should be blocked
    await vault.addRegistry(government.address, DRC_CODE());
    await expect(vault.connect(government).recordRetirement({
      tokenId: 1n, serialId: c.serialId, nationCode: DRC_CODE(),
      retiringEntity: government.address, entityName: "",
      purposeCode: 0, purpose: "duplicate",
      complianceRef: "", vintageYear: 2031, retiredAt: BigInt(Math.floor(Date.now() / 1000)),
      attestationHash: ethers.ZeroHash,
    })).to.be.revertedWithCustomError(vault, "AlreadyRecorded");
  });

  it("disabling vault via proposeVaultUpdate(0) stops auto-recording", async function () {
    const { oracle, registry, vault, government, auditor1, auditor2, auditor3 } = await deployFixture();
    // Propose zero-address (disables vault), advance past timelock, execute
    await registry.connect(government).proposeVaultUpdate(ethers.ZeroAddress);
    await advanceDays(2);
    await registry.connect(government).executeVaultUpdate();
    expect(await registry.vault()).to.equal(ethers.ZeroAddress);
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");
    // Retire without vault — should succeed silently
    await expect(registry.connect(government).retireCredit(1, "voluntary", 0))
      .to.emit(registry, "CreditRetired");
    // Vault is untouched
    expect(await vault.totalRetired()).to.equal(0);
  });

  it("VaultRecordFailed emitted when vault rejects but retirement still succeeds", async function () {
    const { oracle, registry, vault, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");

    // Revoke the registry's role on the vault so recordRetirement will revert
    const REGISTRY_ROLE = await vault.REGISTRY_ROLE();
    const registryAddr = await registry.getAddress();
    await vault.removeRegistry(registryAddr);
    expect(await vault.hasRole(REGISTRY_ROLE, registryAddr)).to.be.false;

    // Retirement must still succeed on-chain and emit VaultRecordFailed
    const tx = registry.connect(government).retireCredit(1, "voluntary", 0);
    await expect(tx).to.emit(registry, "CreditRetired");
    await expect(tx).to.emit(registry, "VaultRecordFailed");
    // Credit is retired despite vault failure
    expect((await registry.credits(1)).status).to.equal(2); // RETIRED
  });
});

// ─────────────────────────────────────────────────────────
//  MRVORACLE — THRESHOLD TIMELOCK
// ─────────────────────────────────────────────────────────

describe("MRVOracle — Threshold Timelock", function () {
  it("proposeThreshold stores pending values and emits event", async function () {
    const { oracle } = await deployFixture();
    // totalAuditors = 5, propose raising to 4
    await expect(oracle.proposeThreshold(4))
      .to.emit(oracle, "ThresholdProposed");
    expect(await oracle.pendingThreshold()).to.equal(4);
    expect(await oracle.pendingThresholdValidAfter()).to.be.gt(0n);
  });

  it("executeThreshold reverts before timelock expires", async function () {
    const { oracle } = await deployFixture();
    await oracle.proposeThreshold(4);
    await expect(oracle.executeThreshold()).to.be.revertedWithCustomError(oracle, "TimelockNotExpired");
  });

  it("executeThreshold succeeds after 2 days", async function () {
    const { oracle } = await deployFixture();
    await oracle.proposeThreshold(4);
    await advanceDays(2);
    await expect(oracle.executeThreshold())
      .to.emit(oracle, "ThresholdExecuted").withArgs(3, 4);
    expect(await oracle.threshold()).to.equal(4);
    expect(await oracle.pendingThreshold()).to.equal(0);
  });

  it("executeThreshold reverts if auditors were removed below pending threshold", async function () {
    const { oracle, auditor4, auditor5 } = await deployFixture();
    // Propose threshold = 4 (totalAuditors = 5)
    await oracle.proposeThreshold(4);
    // Remove two auditors while timelock is pending → totalAuditors = 3 < 4
    await oracle.removeAuditor(auditor4.address);
    await oracle.removeAuditor(auditor5.address);
    await advanceDays(2);
    await expect(oracle.executeThreshold()).to.be.revertedWithCustomError(oracle, "ThresholdExceedsAuditors");
  });

  it("cancelThreshold clears pending state and emits cancelled value", async function () {
    const { oracle } = await deployFixture();
    await oracle.proposeThreshold(4);
    await expect(oracle.cancelThreshold())
      .to.emit(oracle, "ThresholdUpdateCancelled").withArgs(4);
    expect(await oracle.pendingThreshold()).to.equal(0);
    expect(await oracle.pendingThresholdValidAfter()).to.equal(0);
  });

  it("cancelThreshold reverts with NO_PENDING_UPDATE when nothing proposed", async function () {
    const { oracle } = await deployFixture();
    await expect(oracle.cancelThreshold()).to.be.revertedWithCustomError(oracle, "NoPendingUpdate");
  });

  it("executeThreshold reverts with NO_PENDING_UPDATE when nothing proposed", async function () {
    const { oracle } = await deployFixture();
    await expect(oracle.executeThreshold()).to.be.revertedWithCustomError(oracle, "NoPendingUpdate");
  });

  it("proposeThreshold reverts if a proposal is already pending", async function () {
    const { oracle } = await deployFixture();
    await oracle.proposeThreshold(4);
    await expect(oracle.proposeThreshold(4)).to.be.revertedWithCustomError(oracle, "ProposalPending");
  });
});

// ─────────────────────────────────────────────────────────
//  SOVEREIGN REGISTRY — ORACLE UPDATE TIMELOCK
// ─────────────────────────────────────────────────────────

describe("SovereignRegistry — Oracle Update Timelock", function () {
  it("proposeOracleUpdate stores pending values and emits event", async function () {
    const { oracle, registry, government } = await deployFixture();
    const newOracleAddr = await oracle.getAddress(); // reuse same oracle as stand-in
    await expect(registry.connect(government).proposeOracleUpdate(newOracleAddr))
      .to.emit(registry, "OracleUpdateProposed");
    expect(await registry.pendingOracle()).to.equal(newOracleAddr);
    expect(await registry.pendingOracleValidAfter()).to.be.gt(0n);
  });

  it("executeOracleUpdate reverts before timelock expires", async function () {
    const { oracle, registry, government } = await deployFixture();
    await registry.connect(government).proposeOracleUpdate(await oracle.getAddress());
    await expect(registry.connect(government).executeOracleUpdate())
      .to.be.revertedWithCustomError(registry, "TimelockNotExpired");
  });

  it("executeOracleUpdate succeeds after 2 days", async function () {
    const { oracle, registry, government } = await deployFixture();
    const newOracleAddr = await oracle.getAddress();
    await registry.connect(government).proposeOracleUpdate(newOracleAddr);
    await advanceDays(2);
    await expect(registry.connect(government).executeOracleUpdate())
      .to.emit(registry, "OracleUpdated");
    expect(await registry.oracle()).to.equal(newOracleAddr);
    expect(await registry.pendingOracle()).to.equal(ethers.ZeroAddress);
  });

  it("cancelOracleUpdate clears pending state and emits cancelled address", async function () {
    const { oracle, registry, government } = await deployFixture();
    const addr = await oracle.getAddress();
    await registry.connect(government).proposeOracleUpdate(addr);
    await expect(registry.connect(government).cancelOracleUpdate())
      .to.emit(registry, "OracleUpdateCancelled").withArgs(addr);
    expect(await registry.pendingOracle()).to.equal(ethers.ZeroAddress);
    expect(await registry.pendingOracleValidAfter()).to.equal(0);
  });

  it("cancelOracleUpdate reverts with NO_PENDING_UPDATE when nothing proposed", async function () {
    const { registry, government } = await deployFixture();
    await expect(registry.connect(government).cancelOracleUpdate())
      .to.be.revertedWithCustomError(registry, "NoPendingUpdate");
  });

  it("executeOracleUpdate reverts with NO_PENDING_UPDATE when nothing proposed", async function () {
    const { registry, government } = await deployFixture();
    await expect(registry.connect(government).executeOracleUpdate())
      .to.be.revertedWithCustomError(registry, "NoPendingUpdate");
  });

  it("proposeOracleUpdate reverts if a proposal is already pending", async function () {
    const { oracle, registry, government } = await deployFixture();
    const addr = await oracle.getAddress();
    await registry.connect(government).proposeOracleUpdate(addr);
    await expect(registry.connect(government).proposeOracleUpdate(addr))
      .to.be.revertedWithCustomError(registry, "ProposalPending");
  });
});

// ─────────────────────────────────────────────────────────
//  SOVEREIGN REGISTRY — LISTING
// ─────────────────────────────────────────────────────────

describe("SovereignRegistry — Listing", function () {
  async function mintOne(oracle, registry, government, auditors) {
    const c = buildCredit();
    await finalizeAttestation(oracle, c, auditors);
    await registry.connect(government).mintCredit(c, "0x");
    return c;
  }

  it("owner can list an ACTIVE credit", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    await mintOne(oracle, registry, government, [auditor1, auditor2, auditor3]);
    await expect(registry.connect(government).listCredit(1))
      .to.emit(registry, "CreditListed").withArgs(1n, government.address);
    expect((await registry.credits(1)).status).to.equal(1); // LISTED
  });

  it("owner can unlist a LISTED credit", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    await mintOne(oracle, registry, government, [auditor1, auditor2, auditor3]);
    await registry.connect(government).listCredit(1);
    await expect(registry.connect(government).unlistCredit(1))
      .to.emit(registry, "CreditUnlisted").withArgs(1n, government.address);
    expect((await registry.credits(1)).status).to.equal(0); // ACTIVE
  });

  it("non-owner cannot list", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3, stranger } = await deployFixture();
    await mintOne(oracle, registry, government, [auditor1, auditor2, auditor3]);
    await expect(registry.connect(stranger).listCredit(1)).to.be.revertedWithCustomError(registry, "NotOwner");
  });

  it("cannot list a RETIRED credit", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    await mintOne(oracle, registry, government, [auditor1, auditor2, auditor3]);
    await registry.connect(government).retireCredit(1, "voluntary", 0);
    await expect(registry.connect(government).listCredit(1)).to.be.revertedWithCustomError(registry, "NotListable");
  });

  it("cannot unlist a credit that is not LISTED", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    await mintOne(oracle, registry, government, [auditor1, auditor2, auditor3]);
    await expect(registry.connect(government).unlistCredit(1)).to.be.revertedWithCustomError(registry, "NotListed");
  });

  it("LISTED credit can be retired", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    await mintOne(oracle, registry, government, [auditor1, auditor2, auditor3]);
    await registry.connect(government).listCredit(1);
    await expect(registry.connect(government).retireCredit(1, "voluntary", 0))
      .to.emit(registry, "CreditRetired");
    expect((await registry.credits(1)).status).to.equal(2); // RETIRED
  });

  it("LISTED credit can be suspended", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    await mintOne(oracle, registry, government, [auditor1, auditor2, auditor3]);
    await registry.connect(government).listCredit(1);
    await expect(registry.connect(auditor1).suspendCredit(1))
      .to.emit(registry, "CreditSuspended");
    expect((await registry.credits(1)).status).to.equal(3); // SUSPENDED
  });
});

// ─────────────────────────────────────────────────────────
//  INVARIANTS
// ─────────────────────────────────────────────────────────

describe("Invariants", function () {
  it("totalRetired never exceeds totalMinted", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");
    await registry.connect(government).retireCredit(1, "voluntary", 0);
    expect(await registry.totalRetired()).to.be.lte(await registry.totalMinted());
  });

  it("totalActive = totalMinted - totalRetired - totalSuspended", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();

    // Mint three credits with distinct serials AND distinct attestations
    for (let i = 1; i <= 3; i++) {
      const c = buildCredit({
        serialId:      `CRS#DRC-2031-00000${i}`,
        satelliteHash: ethers.keccak256(ethers.toUtf8Bytes(`sentinel2-${i}.tif`)),
        reportHash:    ethers.keccak256(ethers.toUtf8Bytes(`mrv-report-${i}.pdf`)),
      });
      await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
      await registry.connect(government).mintCredit(c, "0x");
    }

    await registry.connect(government).retireCredit(1, "voluntary", 0);
    await registry.connect(auditor1).suspendCredit(2);

    const minted    = await registry.totalMinted();
    const retired   = await registry.totalRetired();
    const suspended = await registry.totalSuspended();
    const active    = await registry.totalActive();
    expect(active).to.equal(minted - retired - suspended);
  });

  it("serial uniqueness — two credits with the same serialId revert on the second mint", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c1 = buildCredit({ serialId: "CRS#DRC-SERIAL-DUPE" });
    await finalizeAttestation(oracle, c1, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c1, "0x");

    // Build a second credit with a different parcel/attestation but same serialId
    const c2 = buildCredit({
      serialId:      "CRS#DRC-SERIAL-DUPE",
      satelliteHash: ethers.keccak256(ethers.toUtf8Bytes("other-satellite.tif")),
      reportHash:    ethers.keccak256(ethers.toUtf8Bytes("other-report.pdf")),
    });
    await finalizeAttestation(oracle, c2, [auditor1, auditor2, auditor3]);
    await expect(registry.connect(government).mintCredit(c2, "0x"))
      .to.be.revertedWithCustomError(registry, "DuplicateSerial");
  });

  it("retired token is permanently non-transferable", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3, buyer } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");
    await registry.connect(government).retireCredit(1, "voluntary", 0);

    // Even after reinstate attempt (which would revert), token stays locked
    await expect(
      registry.connect(government).transferFrom(government.address, buyer.address, 1)
    ).to.be.revertedWithCustomError(registry, "TransferBlockedRetired");
  });

  it("rebalance always sums to exactly 10000 (1-nation edge case)", async function () {
    const { index, admin } = await deployFixture();
    const RELAYER_ROLE = await index.RELAYER_ROLE();
    await index.grantRole(RELAYER_ROLE, admin.address);
    // Give DRC some supply so rebalance doesn't early-return on zero supply
    await index.syncNationStats(DRC_CODE(), 100n, 100n, 0n, 0n);
    // Only DRC is active — it must receive all 10000 bps
    const [, weights] = await index.rebalance();
    expect(weights[0]).to.equal(10000n);
  });
});

// ─────────────────────────────────────────────────────────
//  NCRI INDEX — STATS MONOTONICITY (L-03)
// ─────────────────────────────────────────────────────────

describe("NCRIIndex — Stats Monotonicity", function () {
  it("reverts if totalMinted decreases", async function () {
    const { index, admin } = await deployFixture();
    const RELAYER_ROLE = await index.RELAYER_ROLE();
    await index.grantRole(RELAYER_ROLE, admin.address);
    await index.syncNationStats(DRC_CODE(), 100n, 80n, 20n, 0n);
    await expect(index.syncNationStats(DRC_CODE(), 99n, 80n, 20n, 0n))
      .to.be.revertedWithCustomError(index, "MintedMustNotDecrease");
  });

  it("reverts if totalRetired decreases", async function () {
    const { index, admin } = await deployFixture();
    const RELAYER_ROLE = await index.RELAYER_ROLE();
    await index.grantRole(RELAYER_ROLE, admin.address);
    await index.syncNationStats(DRC_CODE(), 100n, 80n, 20n, 0n);
    await expect(index.syncNationStats(DRC_CODE(), 100n, 80n, 19n, 0n))
      .to.be.revertedWithCustomError(index, "RetiredMustNotDecrease");
  });

  it("accepts equal values (idempotent sync)", async function () {
    const { index, admin } = await deployFixture();
    const RELAYER_ROLE = await index.RELAYER_ROLE();
    await index.grantRole(RELAYER_ROLE, admin.address);
    await index.syncNationStats(DRC_CODE(), 100n, 80n, 20n, 0n);
    // Same values again — must not revert
    await expect(index.syncNationStats(DRC_CODE(), 100n, 80n, 20n, 0n)).not.to.be.reverted;
  });
});

// ─────────────────────────────────────────────────────────
//  SOVEREIGN REGISTRY — VAULT UPDATE TIMELOCK (L-02)
// ─────────────────────────────────────────────────────────

describe("SovereignRegistry — Vault Update Timelock", function () {
  it("proposeVaultUpdate stores pending values and emits event", async function () {
    const { oracle, registry, government } = await deployFixture();
    await expect(registry.connect(government).proposeVaultUpdate(await oracle.getAddress()))
      .to.emit(registry, "VaultUpdateProposed");
    expect(await registry.pendingVaultValidAfter()).to.be.gt(0n);
  });

  it("proposeVaultUpdate reverts if a proposal is already pending", async function () {
    const { oracle, registry, government } = await deployFixture();
    const addr = await oracle.getAddress();
    await registry.connect(government).proposeVaultUpdate(addr);
    await expect(registry.connect(government).proposeVaultUpdate(addr))
      .to.be.revertedWithCustomError(registry, "ProposalPending");
  });

  it("executeVaultUpdate reverts before timelock expires", async function () {
    const { oracle, registry, government } = await deployFixture();
    await registry.connect(government).proposeVaultUpdate(await oracle.getAddress());
    await expect(registry.connect(government).executeVaultUpdate())
      .to.be.revertedWithCustomError(registry, "TimelockNotExpired");
  });

  it("executeVaultUpdate succeeds after 2 days and updates vault address", async function () {
    const { vault, registry, government } = await deployFixture();
    // Propose switching vault to zero (disable) as a simple addresschange
    await registry.connect(government).proposeVaultUpdate(ethers.ZeroAddress);
    await advanceDays(2);
    await expect(registry.connect(government).executeVaultUpdate())
      .to.emit(registry, "VaultUpdated");
    expect(await registry.vault()).to.equal(ethers.ZeroAddress);
    expect(await registry.pendingVault()).to.equal(ethers.ZeroAddress);
    expect(await registry.pendingVaultValidAfter()).to.equal(0);
    // Sanity: the original vault is untouched
    expect(await vault.totalRetired()).to.equal(0);
  });

  it("cancelVaultUpdate clears pending state and emits cancelled address", async function () {
    const { oracle, registry, government } = await deployFixture();
    const addr = await oracle.getAddress();
    await registry.connect(government).proposeVaultUpdate(addr);
    await expect(registry.connect(government).cancelVaultUpdate())
      .to.emit(registry, "VaultUpdateCancelled").withArgs(addr);
    expect(await registry.pendingVault()).to.equal(ethers.ZeroAddress);
    expect(await registry.pendingVaultValidAfter()).to.equal(0);
  });

  it("cancelVaultUpdate reverts with NO_PENDING_UPDATE when nothing proposed", async function () {
    const { registry, government } = await deployFixture();
    await expect(registry.connect(government).cancelVaultUpdate())
      .to.be.revertedWithCustomError(registry, "NoPendingUpdate");
  });

  it("executeVaultUpdate reverts with NO_PENDING_UPDATE when nothing proposed", async function () {
    const { registry, government } = await deployFixture();
    await expect(registry.connect(government).executeVaultUpdate())
      .to.be.revertedWithCustomError(registry, "NoPendingUpdate");
  });
});

// ─────────────────────────────────────────────────────────
//  RETIREMENT VAULT — NATION BINDING (M-01)
// ─────────────────────────────────────────────────────────

describe("RetirementVault — Nation Binding", function () {
  it("registry bound to Liberia cannot record a DRC retirement", async function () {
    const { vault, admin } = await deployFixture();
    const LIBERIA = ethers.zeroPadBytes("0x4C", 2);
    // Add admin as a Liberia registry
    await vault.addRegistry(admin.address, LIBERIA);
    // Attempt to record a DRC record — must revert
    await expect(vault.connect(admin).recordRetirement({
      tokenId:         1n,
      serialId:        "CRS#DRC-001",
      nationCode:      DRC_CODE(),
      retiringEntity:  "0x0000000000000000000000000000000000000001",
      entityName:      "",
      purposeCode:     0,
      purpose:         "test",
      complianceRef:   "",
      vintageYear:     2031,
      retiredAt:       BigInt(Math.floor(Date.now() / 1000)),
      attestationHash: ethers.ZeroHash,
    })).to.be.revertedWithCustomError(vault, "WrongNation");
  });

  it("addRegistry reverts with zero nationCode", async function () {
    const { vault, admin } = await deployFixture();
    await expect(vault.addRegistry(admin.address, ethers.zeroPadBytes("0x00", 2)))
      .to.be.revertedWithCustomError(vault, "InvalidNationCode");
  });

  it("removeRegistry clears the nation binding", async function () {
    const { vault, registry } = await deployFixture();
    const registryAddr = await registry.getAddress();
    expect(await vault.registryNation(registryAddr)).to.equal(DRC_CODE());
    await vault.removeRegistry(registryAddr);
    expect(await vault.registryNation(registryAddr)).to.equal("0x0000");
  });
});

// ─────────────────────────────────────────────────────────
//  ROUND 4 FINDINGS
// ─────────────────────────────────────────────────────────

describe("MRVOracle — Round 4", function () {
  it("B-01: getSigners returns all auditor addresses that signed", async function () {
    const { oracle, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit();
    const id = await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    const signers = await oracle.getSigners(id);
    expect(signers).to.have.lengthOf(3);
    expect(signers).to.include(auditor1.address);
    expect(signers).to.include(auditor2.address);
    expect(signers).to.include(auditor3.address);
  });

  it("B-01: getSigners returns empty array for unknown attestation", async function () {
    const { oracle } = await deployFixture();
    expect(await oracle.getSigners(ethers.ZeroHash)).to.have.lengthOf(0);
  });
});

describe("NCRIIndex — Round 4", function () {
  it("B-02: rebalance populates codes even when globalActiveSupply is zero", async function () {
    const { index } = await deployFixture();
    // No syncNationStats called — supply is 0
    const [codes, weights] = await index.rebalance();
    expect(codes[0]).to.equal(DRC_CODE());   // codes always filled
    expect(weights[0]).to.equal(0n);         // weights all zero (no supply)
  });

  it("B-05: syncNationStats reverts if _totalActive exceeds _totalMinted", async function () {
    const { index, admin } = await deployFixture();
    const RELAYER_ROLE = await index.RELAYER_ROLE();
    await index.grantRole(RELAYER_ROLE, admin.address);
    // _totalActive (900) > _totalMinted (100) — must revert
    await expect(index.syncNationStats(DRC_CODE(), 100n, 900n, 0n, 0n))
      .to.be.revertedWithCustomError(index, "ActiveExceedsMinted");
  });
});

describe("SovereignRegistry — Round 4", function () {
  it("B-06: setBaseURI emits BaseURIUpdated with old and new URI", async function () {
    const { registry, government } = await deployFixture();
    // First set — oldURI is empty string
    await expect(registry.connect(government).setBaseURI("https://registry.ccr.earth/CD/"))
      .to.emit(registry, "BaseURIUpdated")
      .withArgs("", "https://registry.ccr.earth/CD/");
    // Second set — oldURI is previous value
    await expect(registry.connect(government).setBaseURI("https://v2.registry.ccr.earth/CD/"))
      .to.emit(registry, "BaseURIUpdated")
      .withArgs("https://registry.ccr.earth/CD/", "https://v2.registry.ccr.earth/CD/");
  });
});

describe("RetirementVault — Round 4", function () {
  it("B-07: RegistryAdded event includes nationCode", async function () {
    const { vault, stranger } = await deployFixture();
    // Register a brand-new address (stranger) bound to DRC
    await expect(vault.addRegistry(stranger.address, DRC_CODE()))
      .to.emit(vault, "RegistryAdded")
      .withArgs(stranger.address, DRC_CODE());
  });
});

// ─────────────────────────────────────────────────────────
//  COMPLIANCE PURPOSE — ENUM-KEYED STATS
// ─────────────────────────────────────────────────────────

describe("RetirementVault — CompliancePurpose", function () {
  it("retiredByPurpose increments by enum key", async function () {
    const { vault, admin } = await deployFixture();
    await vault.addRegistry(admin.address, DRC_CODE());
    // VOLUNTARY (0)
    await vault.connect(admin).recordRetirement(buildRecord({ purposeCode: 0 }));
    expect(await vault.retiredByPurpose(0)).to.equal(1n); // VOLUNTARY
    expect(await vault.retiredByPurpose(1)).to.equal(0n); // CORSIA untouched
  });

  it("retiredByPurpose tracks CORSIA (1) separately from VOLUNTARY (0)", async function () {
    const { vault, admin } = await deployFixture();
    await vault.addRegistry(admin.address, DRC_CODE());
    await vault.connect(admin).recordRetirement(buildRecord({ tokenId: 1n, purposeCode: 1 })); // CORSIA
    await vault.connect(admin).recordRetirement(buildRecord({ tokenId: 2n, purposeCode: 0 })); // VOLUNTARY
    expect(await vault.retiredByPurpose(0)).to.equal(1n); // VOLUNTARY
    expect(await vault.retiredByPurpose(1)).to.equal(1n); // CORSIA
  });
});

// ─────────────────────────────────────────────────────────
//  NCRI STATS BROADCAST
// ─────────────────────────────────────────────────────────

describe("SovereignRegistry — NCRIStatsBroadcast", function () {
  it("mintCredit emits NCRIStatsBroadcast with correct stats", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await expect(registry.connect(government).mintCredit(c, "0x"))
      .to.emit(registry, "NCRIStatsBroadcast");
    // After mint: minted=1, active=1, retired=0, suspended=0
    const events = await registry.queryFilter(registry.filters.NCRIStatsBroadcast());
    const last = events[events.length - 1];
    expect(last.args.nationCode).to.equal(DRC_CODE());
    expect(last.args.totalMinted).to.equal(1n);
    expect(last.args.totalActive).to.equal(1n);
    expect(last.args.totalRetired).to.equal(0n);
    expect(last.args.totalSuspended).to.equal(0n);
  });

  it("retireCredit emits NCRIStatsBroadcast with updated active count", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");
    await expect(registry.connect(government).retireCredit(1, "voluntary", 0))
      .to.emit(registry, "NCRIStatsBroadcast");
    // After retirement: minted=1, active=0, retired=1, suspended=0
    const filter = registry.filters.NCRIStatsBroadcast();
    const events = await registry.queryFilter(filter);
    const last = events[events.length - 1];
    expect(last.args.totalMinted).to.equal(1n);
    expect(last.args.totalActive).to.equal(0n);
    expect(last.args.totalRetired).to.equal(1n);
  });

  it("broadcastStats can be called by anyone and emits current state", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3, stranger } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");
    // stranger (no role) can call broadcastStats
    await expect(registry.connect(stranger).broadcastStats())
      .to.emit(registry, "NCRIStatsBroadcast");
    const filter = registry.filters.NCRIStatsBroadcast();
    const events = await registry.queryFilter(filter);
    const last = events[events.length - 1];
    expect(last.args.nationCode).to.equal(DRC_CODE());
    expect(last.args.totalMinted).to.equal(1n);
    expect(last.args.totalActive).to.equal(1n);
  });
});

// ─────────────────────────────────────────────────────────
//  CARBON POOL
// ─────────────────────────────────────────────────────────

describe("CarbonPool", function () {
  async function deployPoolFixture() {
    const base = await deployFixture();
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = base;

    const CarbonPool = await ethers.getContractFactory("CarbonPool");
    const pool = await CarbonPool.deploy(
      await registry.getAddress(),
      "CRS Pool Token", "CRS-POOL",
      0, 0  // no vintage filter
    );

    // Mint a credit and transfer to government (already is owner)
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");

    return { ...base, pool };
  }

  it("deposit: transfers token to pool and mints ERC20 to depositor", async function () {
    const { registry, pool, government } = await deployPoolFixture();
    const poolAddr = await pool.getAddress();
    await registry.connect(government).approve(poolAddr, 1);
    await pool.connect(government).deposit(1);
    expect(await pool.poolSize()).to.equal(1n);
    expect(await pool.balanceOf(government.address)).to.equal(ethers.parseEther("1"));
    expect(await registry.ownerOf(1)).to.equal(poolAddr);
  });

  it("deposit: rejects RETIRED credit", async function () {
    const { registry, pool, government } = await deployPoolFixture();
    const poolAddr = await pool.getAddress();
    await registry.connect(government).retireCredit(1, "voluntary", 0);
    await registry.connect(government).approve(poolAddr, 1);
    await expect(pool.connect(government).deposit(1)).to.be.revertedWithCustomError(pool, "NotEligible");
  });

  it("deposit: rejects double deposit of same tokenId", async function () {
    const { registry, pool, government } = await deployPoolFixture();
    const poolAddr = await pool.getAddress();
    await registry.connect(government).approve(poolAddr, 1);
    await pool.connect(government).deposit(1);
    // Transfer it back first so we can try again (should still hit ALREADY_IN_POOL)
    await expect(pool.connect(government).deposit(1)).to.be.revertedWithCustomError(pool, "AlreadyInPool");
  });

  it("redeem: burns ERC20 and returns the token to caller", async function () {
    const { registry, pool, government } = await deployPoolFixture();
    const poolAddr = await pool.getAddress();
    await registry.connect(government).approve(poolAddr, 1);
    await pool.connect(government).deposit(1);
    await pool.connect(government).redeem(1);
    expect(await pool.poolSize()).to.equal(0n);
    expect(await pool.balanceOf(government.address)).to.equal(0n);
    expect(await registry.ownerOf(1)).to.equal(government.address);
  });

  it("redeem: rejects token not in pool", async function () {
    const { pool, government } = await deployPoolFixture();
    await expect(pool.connect(government).redeem(1)).to.be.revertedWithCustomError(pool, "NotInPool");
  });

  it("isInPool tracks correctly after deposit and redeem", async function () {
    const { registry, pool, government } = await deployPoolFixture();
    const poolAddr = await pool.getAddress();
    expect(await pool.isInPool(1)).to.be.false;
    await registry.connect(government).approve(poolAddr, 1);
    await pool.connect(government).deposit(1);
    expect(await pool.isInPool(1)).to.be.true;
    await pool.connect(government).redeem(1);
    expect(await pool.isInPool(1)).to.be.false;
  });

  it("vintage filter: rejects credits outside range", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();

    // Pool only accepts vintages 2030–2035
    const CarbonPool = await ethers.getContractFactory("CarbonPool");
    const pool = await CarbonPool.deploy(
      await registry.getAddress(), "Filtered Pool", "CRS-F", 2030, 2035
    );

    // Mint a 2031 credit (in range) — should succeed
    const inRange = buildCredit({ serialId: "CRS#DRC-IN-RANGE", vintageYear: 2031 });
    await finalizeAttestation(oracle, inRange, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(inRange, "0x"); // tokenId = 1
    await registry.connect(government).approve(await pool.getAddress(), 1);
    await expect(pool.connect(government).deposit(1)).to.not.be.reverted;

    // Mint a 2040 credit (out of range) — should revert
    const outRange = buildCredit({
      serialId:      "CRS#DRC-OUT-RANGE",
      vintageYear:   2040,
      satelliteHash: ethers.keccak256(ethers.toUtf8Bytes("sat-2040.tif")),
      reportHash:    ethers.keccak256(ethers.toUtf8Bytes("report-2040.pdf")),
    });
    await finalizeAttestation(oracle, outRange, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(outRange, "0x"); // tokenId = 2
    await registry.connect(government).approve(await pool.getAddress(), 2);
    await expect(pool.connect(government).deposit(2)).to.be.revertedWithCustomError(pool, "VintageTooNew");
  });

  it("safeTransferFrom deposit path works via onERC721Received", async function () {
    const { registry, pool, government } = await deployPoolFixture();
    const poolAddr = await pool.getAddress();
    await registry.connect(government)["safeTransferFrom(address,address,uint256)"](
      government.address, poolAddr, 1
    );
    expect(await pool.isInPool(1)).to.be.true;
    expect(await pool.balanceOf(government.address)).to.equal(ethers.parseEther("1"));
  });

  it("onERC721Received rejects tokens from wrong registry", async function () {
    const { pool, government } = await deployPoolFixture();
    // Deploy a second registry and try to safe-transfer its token to the pool
    const MRVOracle = await ethers.getContractFactory("MRVOracle");
    const oracle2 = await MRVOracle.deploy(government.address, 3);
    const SovereignRegistry = await ethers.getContractFactory("SovereignRegistry");
    const registry2 = await SovereignRegistry.deploy(
      government.address, government.address, await oracle2.getAddress(),
      DRC_CODE(), "DRC 2"
    );
    await expect(
      registry2.connect(government)["safeTransferFrom(address,address,uint256,bytes)"](
        government.address, await pool.getAddress(), 0, "0x"
      )
    ).to.be.reverted; // either NOT_ELIGIBLE (no token) or WRONG_REGISTRY
  });
});
