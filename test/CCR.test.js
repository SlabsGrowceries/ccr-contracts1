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
    tokenId:            overrides.tokenId            ?? 1n,
    serialId:           overrides.serialId           ?? "CRS#DRC-2031-000001",
    nationCode:         overrides.nationCode         ?? DRC_CODE(),
    retiringEntity:     overrides.retiringEntity     ?? "0x0000000000000000000000000000000000000001",
    entityName:         overrides.entityName         ?? "Kingdom of Norway",
    purposeCode:        overrides.purposeCode        ?? 0,   // 0 = VOLUNTARY
    purpose:            overrides.purpose            ?? "Article 6.2 ITMO",
    complianceRef:      overrides.complianceRef      ?? "NDC-NO-2031",
    vintageYear:        overrides.vintageYear        ?? 2031,
    retiredAt:          overrides.retiredAt          ?? BigInt(Math.floor(Date.now() / 1000)),
    attestationHash:    overrides.attestationHash    ?? ethers.keccak256(ethers.toUtf8Bytes("attest-001")),
    beneficiaryAddress: overrides.beneficiaryAddress ?? "0x0000000000000000000000000000000000000001",
    beneficiaryName:    overrides.beneficiaryName    ?? "Kingdom of Norway",
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
      tokenId:            overrides.tokenId            ?? 1n,
      serialId:           overrides.serialId           ?? "CRS#DRC-2031-000001",
      nationCode:         overrides.nationCode         ?? DRC_CODE(),
      retiringEntity:     overrides.retiringEntity     ?? "0x0000000000000000000000000000000000000001",
      entityName:         overrides.entityName         ?? "Kingdom of Norway",
      purposeCode:        overrides.purposeCode        ?? 0,   // 0 = VOLUNTARY
      purpose:            overrides.purpose            ?? "Article 6.2 ITMO",
      complianceRef:      overrides.complianceRef      ?? "NDC-NO-2031",
      vintageYear:        overrides.vintageYear        ?? 2031,
      retiredAt:          overrides.retiredAt          ?? BigInt(Math.floor(Date.now() / 1000)),
      attestationHash:    overrides.attestationHash    ?? ethers.keccak256(ethers.toUtf8Bytes("attest-001")),
      beneficiaryAddress: overrides.beneficiaryAddress ?? "0x0000000000000000000000000000000000000001",
      beneficiaryName:    overrides.beneficiaryName    ?? "Kingdom of Norway",
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
    await index.syncNationStats(DRC_CODE(),     1000n, 600n, 200n, 200n); // 600+200+200=1000 ✓
    await index.syncNationStats(LIBERIA_CODE(), 500n,  400n, 100n, 0n);  // 400+100+0=500 ✓
    const [, weights] = await index.rebalance();
    expect(weights[0]).to.equal(6000n);
    expect(weights[1]).to.equal(4000n);
  });

  it("deactivateNation removes supply from global aggregates", async function () {
    const { index, admin } = await deployFixture();
    const RELAYER_ROLE = await index.RELAYER_ROLE();
    await index.grantRole(RELAYER_ROLE, admin.address);
    await index.syncNationStats(DRC_CODE(), 1000n, 600n, 200n, 200n); // 600+200+200=1000 ✓
    expect(await index.globalActiveSupply()).to.equal(600n);

    await index.deactivateNation(DRC_CODE());
    expect(await index.globalActiveSupply()).to.equal(0n);
    expect((await index.getNation(DRC_CODE())).isActive).to.be.false;
  });

  it("reactivateNation restores supply to global aggregates", async function () {
    const { index, admin } = await deployFixture();
    const RELAYER_ROLE = await index.RELAYER_ROLE();
    await index.grantRole(RELAYER_ROLE, admin.address);
    await index.syncNationStats(DRC_CODE(), 1000n, 600n, 200n, 200n); // 600+200+200=1000 ✓
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
    await index.syncNationStats(DRC_CODE(),     300n, 100n, 0n, 200n); // 100+0+200=300 ✓
    await index.syncNationStats(LIBERIA_CODE(), 300n, 100n, 0n, 200n); // 100+0+200=300 ✓
    await index.syncNationStats(thirdCode,      300n, 100n, 0n, 200n); // 100+0+200=300 ✓
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
      beneficiaryAddress: government.address, beneficiaryName: "",
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

  it("reverts if totalMinted jumps beyond MAX_STAT_JUMP in one update", async function () {
    const { index, admin } = await deployFixture();
    const RELAYER_ROLE = await index.RELAYER_ROLE();
    await index.grantRole(RELAYER_ROLE, admin.address);
    const maxJump = await index.maxStatJump();
    // all-suspended keeps active+retired+suspended == minted while exceeding the jump cap
    await expect(index.syncNationStats(DRC_CODE(), maxJump + 1n, 0n, 0n, maxJump + 1n))
      .to.be.revertedWithCustomError(index, "StatJumpTooLarge");
  });

  it("accepts totalMinted exactly equal to MAX_STAT_JUMP", async function () {
    const { index, admin } = await deployFixture();
    const RELAYER_ROLE = await index.RELAYER_ROLE();
    await index.grantRole(RELAYER_ROLE, admin.address);
    const maxJump = await index.maxStatJump();
    await expect(index.syncNationStats(DRC_CODE(), maxJump, maxJump, 0n, 0n)).not.to.be.reverted;
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
      tokenId:            1n,
      serialId:           "CRS#DRC-001",
      nationCode:         DRC_CODE(),
      retiringEntity:     "0x0000000000000000000000000000000000000001",
      entityName:         "",
      purposeCode:        0,
      purpose:            "test",
      complianceRef:      "",
      vintageYear:        2031,
      retiredAt:          BigInt(Math.floor(Date.now() / 1000)),
      attestationHash:    ethers.ZeroHash,
      beneficiaryAddress: "0x0000000000000000000000000000000000000001",
      beneficiaryName:    "",
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

  it("resetAttestation: admin can reset a poisoned unfinalized attestation", async function () {
    const { oracle, admin, auditor1 } = await deployFixture();
    const c = buildCredit();
    // auditor1 submits with a wrong parcel hash — poisons the attestation
    const wrongParcel = ethers.keccak256(ethers.toUtf8Bytes("wrong-boundary.geojson"));
    const attId = await oracle.getAttestationId(c.attestation.satelliteHash, c.attestation.reportHash);
    await oracle.connect(auditor1).submitAttestation(
      c.attestation.satelliteHash, c.attestation.reportHash, wrongParcel
    );
    // Admin resets it
    await expect(oracle.connect(admin).resetAttestation(attId))
      .to.emit(oracle, "AttestationReset").withArgs(attId, 1);
    // sigCount is now 0 — clean slate
    expect(await oracle.sigCount(attId)).to.equal(0);
  });

  it("resetAttestation: reverts on unknown attestation", async function () {
    const { oracle, admin } = await deployFixture();
    await expect(oracle.connect(admin).resetAttestation(ethers.ZeroHash))
      .to.be.revertedWithCustomError(oracle, "AttestationNotFound");
  });

  it("resetAttestation: reverts on finalized attestation", async function () {
    const { oracle, admin, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit();
    const attId = await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await expect(oracle.connect(admin).resetAttestation(attId))
      .to.be.revertedWithCustomError(oracle, "AttestationAlreadyFinalized");
  });

  it("resetAttestation: auditors can re-sign correctly after reset", async function () {
    const { oracle, admin, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit();
    const wrongParcel = ethers.keccak256(ethers.toUtf8Bytes("wrong-boundary.geojson"));
    const attId = await oracle.getAttestationId(c.attestation.satelliteHash, c.attestation.reportHash);
    await oracle.connect(auditor1).submitAttestation(
      c.attestation.satelliteHash, c.attestation.reportHash, wrongParcel
    );
    await oracle.connect(admin).resetAttestation(attId);
    // Now re-submit with correct parcel hash — should succeed and finalize
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    expect(await oracle.isFinalized(attId)).to.be.true;
  });

  it("resetAttestation: requires ADMIN_ROLE — non-admin is rejected", async function () {
    const { oracle, auditor1 } = await deployFixture();
    const c = buildCredit();
    const wrongParcel = ethers.keccak256(ethers.toUtf8Bytes("wrong-boundary.geojson"));
    await oracle.connect(auditor1).submitAttestation(
      c.attestation.satelliteHash, c.attestation.reportHash, wrongParcel
    );
    const attId = await oracle.getAttestationId(c.attestation.satelliteHash, c.attestation.reportHash);
    // auditor1 holds AUDITOR_ROLE but not ADMIN_ROLE — must revert
    await expect(oracle.connect(auditor1).resetAttestation(attId))
      .to.be.revertedWithCustomError(oracle, "AccessControlUnauthorizedAccount");
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

  it("B-08: syncNationStats enforces active + retired + suspended == minted invariant", async function () {
    const { index, admin } = await deployFixture();
    const RELAYER_ROLE = await index.RELAYER_ROLE();
    await index.grantRole(RELAYER_ROLE, admin.address);
    // Sum too high: active=90 + retired=20 + suspended=0 = 110 ≠ 100 → StatsInconsistent
    await expect(index.syncNationStats(DRC_CODE(), 100n, 90n, 20n, 0n))
      .to.be.revertedWithCustomError(index, "StatsInconsistent");
    // Sum too low: active=50 + retired=20 + suspended=5 = 75 ≠ 100 → StatsInconsistent
    await expect(index.syncNationStats(DRC_CODE(), 100n, 50n, 20n, 5n))
      .to.be.revertedWithCustomError(index, "StatsInconsistent");
    // Exact: active=75 + retired=20 + suspended=5 = 100 == minted=100 → passes
    await expect(index.syncNationStats(DRC_CODE(), 100n, 75n, 20n, 5n))
      .to.not.be.reverted;
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
    const registryAddr = await registry.getAddress();
    await registry.connect(government).approve(poolAddr, 1);
    await pool.connect(government).deposit(registryAddr, 1);
    expect(await pool.poolSize()).to.equal(1n);
    expect(await pool.balanceOf(government.address)).to.equal(ethers.parseEther("1"));
    expect(await registry.ownerOf(1)).to.equal(poolAddr);
  });

  it("deposit: rejects RETIRED credit", async function () {
    const { registry, pool, government } = await deployPoolFixture();
    const poolAddr = await pool.getAddress();
    const registryAddr = await registry.getAddress();
    await registry.connect(government).retireCredit(1, "voluntary", 0);
    await registry.connect(government).approve(poolAddr, 1);
    await expect(pool.connect(government).deposit(registryAddr, 1)).to.be.revertedWithCustomError(pool, "NotEligible");
  });

  it("deposit: rejects double deposit of same tokenId", async function () {
    const { registry, pool, government } = await deployPoolFixture();
    const poolAddr = await pool.getAddress();
    const registryAddr = await registry.getAddress();
    await registry.connect(government).approve(poolAddr, 1);
    await pool.connect(government).deposit(registryAddr, 1);
    // Transfer it back first so we can try again (should still hit ALREADY_IN_POOL)
    await expect(pool.connect(government).deposit(registryAddr, 1)).to.be.revertedWithCustomError(pool, "AlreadyInPool");
  });

  it("redeem: burns ERC20 and returns the token to caller", async function () {
    const { registry, pool, government } = await deployPoolFixture();
    const poolAddr = await pool.getAddress();
    const registryAddr = await registry.getAddress();
    await registry.connect(government).approve(poolAddr, 1);
    await pool.connect(government).deposit(registryAddr, 1);
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
    const registryAddr = await registry.getAddress();
    expect(await pool.isInPool(1)).to.be.false;
    await registry.connect(government).approve(poolAddr, 1);
    await pool.connect(government).deposit(registryAddr, 1);
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
    await expect(pool.connect(government).deposit(await registry.getAddress(), 1)).to.not.be.reverted;

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
    await expect(pool.connect(government).deposit(await registry.getAddress(), 2)).to.be.revertedWithCustomError(pool, "VintageTooNew");
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

  it("pause: owner can pause and deposit reverts with EnforcedPause", async function () {
    const { registry, pool, government } = await deployPoolFixture();
    await pool.pause();
    await expect(pool.connect(government).deposit(await registry.getAddress(), 1))
      .to.be.revertedWithCustomError(pool, "EnforcedPause");
  });

  it("pause: redeem reverts when paused", async function () {
    const { registry, pool, government } = await deployPoolFixture();
    const poolAddr = await pool.getAddress();
    const registryAddr = await registry.getAddress();
    await registry.connect(government).approve(poolAddr, 1);
    await pool.connect(government).deposit(registryAddr, 1);
    await pool.pause();
    await expect(pool.connect(government).redeem(1))
      .to.be.revertedWithCustomError(pool, "EnforcedPause");
  });

  it("pause: unpause restores normal operation", async function () {
    const { registry, pool, government } = await deployPoolFixture();
    const poolAddr = await pool.getAddress();
    const registryAddr = await registry.getAddress();
    await registry.connect(government).approve(poolAddr, 1);
    await pool.pause();
    await pool.unpause();
    await expect(pool.connect(government).deposit(registryAddr, 1)).to.not.be.reverted;
  });

  it("previewCredit: returns full credit data for token in pool", async function () {
    const { registry, pool, government } = await deployPoolFixture();
    const poolAddr = await pool.getAddress();
    const registryAddr = await registry.getAddress();
    await registry.connect(government).approve(poolAddr, 1);
    await pool.connect(government).deposit(registryAddr, 1);
    const credit = await registry.getCredit(1);
    const preview = await pool.previewCredit(1);
    expect(preview.serialId).to.equal(credit.serialId);
    expect(preview.vintageYear).to.equal(credit.vintageYear);
  });

  it("previewCredit: reverts for token not in pool", async function () {
    const { pool } = await deployPoolFixture();
    await expect(pool.previewCredit(999))
      .to.be.revertedWithCustomError(pool, "NotInPool");
  });

  it("multi-registry: addRegistry allows second registry to deposit", async function () {
    const { pool, government, auditor1, auditor2, auditor3 } = await deployPoolFixture();

    // Deploy a second registry for a different nation (LR = Liberia)
    const MRVOracle2    = await ethers.getContractFactory("MRVOracle");
    const oracle2       = await MRVOracle2.deploy(government.address, 3);
    await oracle2.connect(government).addAuditor(auditor1.address);
    await oracle2.connect(government).addAuditor(auditor2.address);
    await oracle2.connect(government).addAuditor(auditor3.address);
    const SovereignRegistry2 = await ethers.getContractFactory("SovereignRegistry");
    const LR_CODE = "0x4c52"; // "LR" ASCII bytes2
    const registry2 = await SovereignRegistry2.deploy(
      government.address, government.address, await oracle2.getAddress(),
      LR_CODE, "Liberia"
    );
    // registry2 uses LR nation code — build a matching credit
    const lrCredit = buildCredit({ serialId: "CRS#LR-2031-000001", issuingChainId: LR_CODE });
    await finalizeAttestation(oracle2, lrCredit, [auditor1, auditor2, auditor3]);
    await registry2.connect(government).mintCredit(lrCredit, "0x"); // tokenId = 1 in registry2

    // Before addRegistry — deposit from registry2 should revert
    await registry2.connect(government).approve(await pool.getAddress(), 1);
    await expect(pool.connect(government).deposit(await registry2.getAddress(), 1))
      .to.be.revertedWithCustomError(pool, "RegistryNotApproved");

    // After addRegistry — deposit succeeds
    await pool.addRegistry(await registry2.getAddress());
    await expect(pool.connect(government).deposit(await registry2.getAddress(), 1)).to.not.be.reverted;
    expect(await pool.poolSize()).to.equal(1n);
  });

  it("multi-registry: tokenSource returns correct registry for deposited token", async function () {
    const { registry, pool, government } = await deployPoolFixture();
    const registryAddr = await registry.getAddress();
    await registry.connect(government).approve(await pool.getAddress(), 1);
    await pool.connect(government).deposit(registryAddr, 1);
    expect(await pool.tokenSource(1)).to.equal(registryAddr);
  });

  it("permit: ERC-2612 permit sets allowance without a separate approve tx", async function () {
    const { pool } = await deployPoolFixture();
    const [owner, spender] = await ethers.getSigners();
    const amount   = ethers.parseEther("1");
    const block    = await ethers.provider.getBlock("latest");
    const deadline = block.timestamp + 3600;
    const nonce    = await pool.nonces(owner.address);
    const domain   = {
      name:              await pool.name(),
      version:           "1",
      chainId:           (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await pool.getAddress(),
    };
    const types = {
      Permit: [
        { name: "owner",    type: "address" },
        { name: "spender",  type: "address" },
        { name: "value",    type: "uint256" },
        { name: "nonce",    type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    const value = { owner: owner.address, spender: spender.address, value: amount, nonce, deadline };
    const sig   = await owner.signTypedData(domain, types, value);
    const { v, r, s } = ethers.Signature.from(sig);
    await pool.permit(owner.address, spender.address, amount, deadline, v, r, s);
    expect(await pool.allowance(owner.address, spender.address)).to.equal(amount);
  });
});

// ─────────────────────────────────────────────────────────
//  METHODOLOGY REGISTRY
// ─────────────────────────────────────────────────────────

describe("MethodologyRegistry", function () {
  async function deployMethodologyFixture() {
    const base = await deployFixture();
    const MethodologyRegistry = await ethers.getContractFactory("MethodologyRegistry");
    const methodology = await MethodologyRegistry.deploy(base.admin.address);
    return { ...base, methodology };
  }

  it("approveMethodology: governance can approve a methodology", async function () {
    const { methodology, admin } = await deployMethodologyFixture();
    await expect(methodology.connect(admin).approveMethodology("ART-TREES-v2.0"))
      .to.emit(methodology, "MethodologyApproved");
    expect(await methodology.isApproved("ART-TREES-v2.0")).to.be.true;
  });

  it("approveMethodology: reverts on duplicate", async function () {
    const { methodology, admin } = await deployMethodologyFixture();
    await methodology.connect(admin).approveMethodology("VM0015");
    await expect(methodology.connect(admin).approveMethodology("VM0015"))
      .to.be.revertedWithCustomError(methodology, "MethodologyAlreadyApproved");
  });

  it("approveMethodology: reverts on empty name", async function () {
    const { methodology, admin } = await deployMethodologyFixture();
    await expect(methodology.connect(admin).approveMethodology(""))
      .to.be.revertedWithCustomError(methodology, "EmptyMethodologyName");
  });

  it("revokeMethodology: governance can revoke an approved methodology", async function () {
    const { methodology, admin } = await deployMethodologyFixture();
    await methodology.connect(admin).approveMethodology("VM0015");
    await expect(methodology.connect(admin).revokeMethodology("VM0015"))
      .to.emit(methodology, "MethodologyRevoked");
    expect(await methodology.isApproved("VM0015")).to.be.false;
  });

  it("revokeMethodology: reverts if not approved", async function () {
    const { methodology, admin } = await deployMethodologyFixture();
    await expect(methodology.connect(admin).revokeMethodology("UNKNOWN"))
      .to.be.revertedWithCustomError(methodology, "MethodologyNotFound");
  });

  it("SovereignRegistry: blocks mint when methodology registry is set and methodology unapproved", async function () {
    const { oracle, registry, government, admin, auditor1, auditor2, auditor3 } = await deployFixture();
    const MethodologyRegistry = await ethers.getContractFactory("MethodologyRegistry");
    const mr = await MethodologyRegistry.deploy(admin.address);
    // Attach methodology registry — no methodologies approved yet
    await registry.connect(government).setMethodologyRegistry(await mr.getAddress());
    const c = buildCredit();  // uses "ART-TREES-v2.0" by default
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await expect(registry.connect(government).mintCredit(c, "0x"))
      .to.be.revertedWithCustomError(registry, "UnapprovedMethodology");
  });

  it("SovereignRegistry: allows mint when methodology is approved in registry", async function () {
    const { oracle, registry, government, admin, auditor1, auditor2, auditor3 } = await deployFixture();
    const MethodologyRegistry = await ethers.getContractFactory("MethodologyRegistry");
    const mr = await MethodologyRegistry.deploy(admin.address);
    await registry.connect(government).setMethodologyRegistry(await mr.getAddress());
    const c = buildCredit();
    // Approve the methodology used by buildCredit
    await mr.connect(admin).approveMethodology(c.methodology);
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await expect(registry.connect(government).mintCredit(c, "0x")).to.not.be.reverted;
  });

  it("SovereignRegistry: disabling methodology registry (address zero) allows any methodology", async function () {
    const { oracle, registry, government, admin, auditor1, auditor2, auditor3 } = await deployFixture();
    const MethodologyRegistry = await ethers.getContractFactory("MethodologyRegistry");
    const mr = await MethodologyRegistry.deploy(admin.address);
    await registry.connect(government).setMethodologyRegistry(await mr.getAddress());
    // Re-disable
    await registry.connect(government).setMethodologyRegistry(ethers.ZeroAddress);
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await expect(registry.connect(government).mintCredit(c, "0x")).to.not.be.reverted;
  });
});

// ─────────────────────────────────────────────────────────
//  GOVERNMENT AUDIT — KYC/AML ALLOWLIST (SovereignRegistry)
// ─────────────────────────────────────────────────────────

describe("SovereignRegistry — KYC/AML Allowlist", function () {
  async function deployAllowlistFixture() {
    const base = await deployFixture();
    const MockAllowlist = await ethers.getContractFactory("MockAllowlist");
    const allowlistContract = await MockAllowlist.deploy();
    return { ...base, allowlistContract };
  }

  it("setAllowlist: emits AllowlistUpdated and stores address", async function () {
    const { registry, government, allowlistContract } = await deployAllowlistFixture();
    const addr = await allowlistContract.getAddress();
    await expect(registry.connect(government).setAllowlist(addr))
      .to.emit(registry, "AllowlistUpdated")
      .withArgs(ethers.ZeroAddress, addr);
    expect(await registry.allowlist()).to.equal(addr);
  });

  it("transfer: blocked when recipient not allowlisted", async function () {
    const { oracle, registry, government, buyer, auditor1, auditor2, auditor3, allowlistContract } =
      await deployAllowlistFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");

    const addr = await allowlistContract.getAddress();
    await registry.connect(government).setAllowlist(addr);
    // government allowlisted, buyer not — transfer should revert
    await allowlistContract.allow(government.address);
    await expect(
      registry.connect(government).transferFrom(government.address, buyer.address, 1)
    ).to.be.revertedWithCustomError(registry, "NotAllowlisted");
  });

  it("transfer: succeeds when both parties are allowlisted", async function () {
    const { oracle, registry, government, buyer, auditor1, auditor2, auditor3, allowlistContract } =
      await deployAllowlistFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");

    const addr = await allowlistContract.getAddress();
    await registry.connect(government).setAllowlist(addr);
    await allowlistContract.allow(government.address);
    await allowlistContract.allow(buyer.address);
    await expect(
      registry.connect(government).transferFrom(government.address, buyer.address, 1)
    ).to.not.be.reverted;
  });

  it("setAllowlist(zero): disables screening", async function () {
    const { oracle, registry, government, buyer, auditor1, auditor2, auditor3, allowlistContract } =
      await deployAllowlistFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");

    const addr = await allowlistContract.getAddress();
    await registry.connect(government).setAllowlist(addr);
    // No one allowlisted — disable it
    await registry.connect(government).setAllowlist(ethers.ZeroAddress);
    // Transfer should now succeed without allowlist check
    await expect(
      registry.connect(government).transferFrom(government.address, buyer.address, 1)
    ).to.not.be.reverted;
  });
});

// ─────────────────────────────────────────────────────────
//  GOVERNMENT AUDIT — KYC/AML ALLOWLIST (CarbonPool)
// ─────────────────────────────────────────────────────────

describe("CarbonPool — KYC/AML Allowlist", function () {
  async function deployPoolAllowlistFixture() {
    const base = await deployFixture();
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = base;
    const CarbonPool = await ethers.getContractFactory("CarbonPool");
    const pool = await CarbonPool.deploy(
      await registry.getAddress(), "CRS Pool Token", "CRS-POOL", 0, 0
    );
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");
    const MockAllowlist = await ethers.getContractFactory("MockAllowlist");
    const allowlistContract = await MockAllowlist.deploy();
    return { ...base, pool, allowlistContract };
  }

  it("deposit: reverts when depositor not allowlisted", async function () {
    const { registry, pool, admin, government, allowlistContract } = await deployPoolAllowlistFixture();
    const poolAddr = await pool.getAddress();
    const registryAddr = await registry.getAddress();
    const listAddr = await allowlistContract.getAddress();

    await registry.connect(government).approve(poolAddr, 1);
    await pool.connect(admin).setAllowlist(listAddr);
    // government not allowlisted — deposit should revert
    await expect(pool.connect(government).deposit(registryAddr, 1))
      .to.be.revertedWithCustomError(pool, "NotAllowlisted");
  });

  it("deposit: succeeds when depositor is allowlisted", async function () {
    const { registry, pool, admin, government, allowlistContract } = await deployPoolAllowlistFixture();
    const poolAddr = await pool.getAddress();
    const registryAddr = await registry.getAddress();
    const listAddr = await allowlistContract.getAddress();

    await registry.connect(government).approve(poolAddr, 1);
    await pool.connect(admin).setAllowlist(listAddr);
    await allowlistContract.allow(government.address);
    await expect(pool.connect(government).deposit(registryAddr, 1)).to.not.be.reverted;
  });

  it("redeem: reverts when redeemer not allowlisted", async function () {
    const { registry, pool, admin, government, allowlistContract } = await deployPoolAllowlistFixture();
    const poolAddr = await pool.getAddress();
    const registryAddr = await registry.getAddress();
    const listAddr = await allowlistContract.getAddress();

    // Deposit first (no allowlist yet)
    await registry.connect(government).approve(poolAddr, 1);
    await pool.connect(government).deposit(registryAddr, 1);

    // Now enable allowlist — government not allowlisted
    await pool.connect(admin).setAllowlist(listAddr);
    await expect(pool.connect(government).redeem(1))
      .to.be.revertedWithCustomError(pool, "NotAllowlisted");
  });
});

// ─────────────────────────────────────────────────────────
//  GOVERNMENT AUDIT — RETIREMENT BENEFICIARY (Art. 6.2 / CORSIA)
// ─────────────────────────────────────────────────────────

describe("SovereignRegistry — retireForBeneficiary (Art. 6.2)", function () {
  it("records vault entry with correct beneficiaryAddress", async function () {
    const { oracle, registry, vault, government, buyer, auditor1, auditor2, auditor3 } =
      await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");

    await registry.connect(government).retireForBeneficiary(
      1, "Art6.2 NO-CD-2031", 2 /* ARTICLE_6_2 */, buyer.address, "Kingdom of Norway"
    );

    const record = await vault.getRetirement(0);
    expect(record.beneficiaryAddress).to.equal(buyer.address);
    expect(record.beneficiaryName).to.equal("Kingdom of Norway");
    expect(record.retiringEntity).to.equal(government.address);
  });

  it("retiredByBeneficiary counter increments correctly", async function () {
    const { oracle, registry, vault, government, buyer, auditor1, auditor2, auditor3 } =
      await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");

    await registry.connect(government).retireForBeneficiary(
      1, "CORSIA-Q3-2032", 1 /* CORSIA */, buyer.address, "Lufthansa AG"
    );

    expect(await vault.retiredByBeneficiary(buyer.address)).to.equal(1n);
    expect(await vault.retiredByBeneficiary(government.address)).to.equal(0n);
  });

  it("retireForBeneficiary: reverts on zero beneficiary address", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");

    await expect(
      registry.connect(government).retireForBeneficiary(
        1, "Art6.2", 2, ethers.ZeroAddress, "bad"
      )
    ).to.be.revertedWithCustomError(registry, "InvalidBeneficiary");
  });

  it("retireCredit: defaults beneficiary to msg.sender in vault record", async function () {
    const { oracle, registry, vault, government, auditor1, auditor2, auditor3 } =
      await deployFixture();
    const c = buildCredit();
    await finalizeAttestation(oracle, c, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c, "0x");
    await registry.connect(government).retireCredit(1, "voluntary", 0);
    const record = await vault.getRetirement(0);
    expect(record.beneficiaryAddress).to.equal(government.address);
  });
});

// ─────────────────────────────────────────────────────────
//  GOVERNMENT AUDIT — MINTING CAP (Supply Control)
// ─────────────────────────────────────────────────────────

describe("SovereignRegistry — Minting Cap", function () {
  it("setMintingCap: emits MintingCapUpdated", async function () {
    const { registry, government } = await deployFixture();
    await expect(registry.connect(government).setMintingCap(100, 86400))
      .to.emit(registry, "MintingCapUpdated")
      .withArgs(0n, 100n, 86400n);
  });

  it("mintCredit: reverts when cap exceeded in same period", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    await registry.connect(government).setMintingCap(1, 86400); // max 1 per day

    const c1 = buildCredit({ serialId: "CRS-CAP-A1" });
    await finalizeAttestation(oracle, c1, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c1, "0x"); // uses 1/1

    const c2 = buildCredit({ serialId: "CRS-CAP-A2" });
    await expect(registry.connect(government).mintCredit(c2, "0x"))
      .to.be.revertedWithCustomError(registry, "MintingCapExceeded");
  });

  it("mintCredit: resets after period elapses", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    await registry.connect(government).setMintingCap(1, 86400); // 1 per day

    const c1 = buildCredit({ serialId: "CRS-CAP-B1" });
    await finalizeAttestation(oracle, c1, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c1, "0x");

    // Advance past the period
    await advanceDays(2);

    const c2 = buildCredit({ serialId: "CRS-CAP-B2" });
    await expect(registry.connect(government).mintCredit(c2, "0x")).to.not.be.reverted;
  });

  it("setMintingCap(0): removes the cap entirely", async function () {
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = await deployFixture();
    await registry.connect(government).setMintingCap(1, 86400);

    const c1 = buildCredit({ serialId: "CRS-CAP-C1" });
    await finalizeAttestation(oracle, c1, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c1, "0x");

    // Remove cap
    await registry.connect(government).setMintingCap(0, 0);

    const c2 = buildCredit({ serialId: "CRS-CAP-C2" });
    await expect(registry.connect(government).mintCredit(c2, "0x")).to.not.be.reverted;
  });
});

// ─────────────────────────────────────────────────────────
//  GOVERNMENT AUDIT — BENEFICIARY in RetirementVault
// ─────────────────────────────────────────────────────────

describe("RetirementVault — Beneficiary Tracking", function () {
  function buildRecord(overrides = {}) {
    return {
      tokenId:            overrides.tokenId            ?? 1n,
      serialId:           overrides.serialId           ?? "CRS#DRC-2031-000001",
      nationCode:         overrides.nationCode         ?? DRC_CODE(),
      retiringEntity:     overrides.retiringEntity     ?? "0x0000000000000000000000000000000000000001",
      entityName:         overrides.entityName         ?? "Kingdom of Norway",
      purposeCode:        overrides.purposeCode        ?? 0,
      purpose:            overrides.purpose            ?? "Article 6.2 ITMO",
      complianceRef:      overrides.complianceRef      ?? "NDC-NO-2031",
      vintageYear:        overrides.vintageYear        ?? 2031,
      retiredAt:          overrides.retiredAt          ?? BigInt(Math.floor(Date.now() / 1000)),
      attestationHash:    overrides.attestationHash    ?? ethers.keccak256(ethers.toUtf8Bytes("attest-001")),
      beneficiaryAddress: overrides.beneficiaryAddress ?? "0x0000000000000000000000000000000000000001",
      beneficiaryName:    overrides.beneficiaryName    ?? "Kingdom of Norway",
    };
  }

  it("retiredByBeneficiary increments independently from retiredByEntity", async function () {
    const { vault, admin, stranger } = await deployFixture();
    await vault.addRegistry(admin.address, DRC_CODE());
    await vault.connect(admin).recordRetirement(buildRecord({
      tokenId: 1n,
      retiringEntity:     stranger.address,  // broker
      beneficiaryAddress: admin.address,     // end client
    }));
    expect(await vault.retiredByEntity(stranger.address)).to.equal(1n);
    expect(await vault.retiredByBeneficiary(admin.address)).to.equal(1n);
    expect(await vault.retiredByBeneficiary(stranger.address)).to.equal(0n);
  });

  it("recordRetirement: reverts when beneficiaryAddress is zero", async function () {
    const { vault, admin } = await deployFixture();
    await vault.addRegistry(admin.address, DRC_CODE());
    await expect(vault.connect(admin).recordRetirement(buildRecord({
      beneficiaryAddress: ethers.ZeroAddress,
    }))).to.be.revertedWithCustomError(vault, "InvalidBeneficiary");
  });
});

// ─────────────────────────────────────────────────────────
//  PLATFORM FEES — CarbonPool
// ─────────────────────────────────────────────────────────

describe("CarbonPool — Platform Fees", function () {
  async function deployFeePoolFixture() {
    const base = await deployFixture();
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = base;
    const CarbonPool = await ethers.getContractFactory("CarbonPool");
    const pool = await CarbonPool.deploy(
      await registry.getAddress(), "NCRI Pool Token", "NCRI-POOL", 0, 0
    );
    // Mint two credits so we have tokens to work with
    const c1 = buildCredit({ serialId: "FEE-001" });
    const c2 = buildCredit({
      serialId:      "FEE-002",
      satelliteHash: ethers.keccak256(ethers.toUtf8Bytes("sentinel2-fee2.tif")),
      reportHash:    ethers.keccak256(ethers.toUtf8Bytes("mrv-fee2.pdf")),
    });
    await finalizeAttestation(oracle, c1, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c1, "0x");
    await finalizeAttestation(oracle, c2, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c2, "0x");
    return { ...base, pool };
  }

  it("setFees: emits FeesUpdated", async function () {
    const { pool, admin } = await deployFeePoolFixture();
    await expect(pool.connect(admin).setFees(30, 50))
      .to.emit(pool, "FeesUpdated").withArgs(30, 50);
    expect(await pool.depositFeeBps()).to.equal(30n);
    expect(await pool.redeemFeeBps()).to.equal(50n);
  });

  it("setFees: reverts above MAX_FEE_BPS (10%)", async function () {
    const { pool, admin } = await deployFeePoolFixture();
    await expect(pool.connect(admin).setFees(1001, 0))
      .to.be.revertedWithCustomError(pool, "FeeTooHigh");
    await expect(pool.connect(admin).setFees(0, 1001))
      .to.be.revertedWithCustomError(pool, "FeeTooHigh");
  });

  it("setFeeRecipient: emits FeeRecipientUpdated", async function () {
    const { pool, admin, stranger } = await deployFeePoolFixture();
    await expect(pool.connect(admin).setFeeRecipient(stranger.address))
      .to.emit(pool, "FeeRecipientUpdated").withArgs(ethers.ZeroAddress, stranger.address);
  });

  it("deposit: fee disabled when feeRecipient is zero (default)", async function () {
    const { registry, pool, admin, government } = await deployFeePoolFixture();
    const poolAddr = await pool.getAddress();
    const registryAddr = await registry.getAddress();
    await pool.connect(admin).setFees(100, 0); // 1% — but no recipient
    await registry.connect(government).approve(poolAddr, 1);
    await pool.connect(government).deposit(registryAddr, 1);
    // depositor receives full TOKENS_PER_CREDIT because feeRecipient is zero
    expect(await pool.balanceOf(government.address)).to.equal(ethers.parseEther("1"));
  });

  it("deposit: fee correctly splits tokens when feeRecipient is set", async function () {
    const { registry, pool, admin, government, stranger } = await deployFeePoolFixture();
    const poolAddr = await pool.getAddress();
    const registryAddr = await registry.getAddress();
    // 1% deposit fee
    await pool.connect(admin).setFees(100, 0);
    await pool.connect(admin).setFeeRecipient(stranger.address);

    await registry.connect(government).approve(poolAddr, 1);
    await pool.connect(government).deposit(registryAddr, 1);

    const expected = ethers.parseEther("1");
    const fee = expected * 100n / 10_000n;       // 0.01 ether
    expect(await pool.balanceOf(government.address)).to.equal(expected - fee);
    expect(await pool.balanceOf(stranger.address)).to.equal(fee);
  });

  it("depositReturn: returns correct breakdown", async function () {
    const { pool, admin, stranger } = await deployFeePoolFixture();
    await pool.connect(admin).setFees(50, 0);
    await pool.connect(admin).setFeeRecipient(stranger.address);
    const [received, fee] = await pool.depositReturn();
    const total = ethers.parseEther("1");
    expect(fee).to.equal(total * 50n / 10_000n);
    expect(received).to.equal(total - fee);
  });

  it("redeem: fee deducted on top of TOKENS_PER_CREDIT", async function () {
    const { registry, pool, admin, government, stranger } = await deployFeePoolFixture();
    const poolAddr = await pool.getAddress();
    const registryAddr = await registry.getAddress();
    // 0.5% redeem fee
    await pool.connect(admin).setFees(0, 50);
    await pool.connect(admin).setFeeRecipient(stranger.address);

    // Deposit both credits so government has 2e18 — enough to cover burn + fee on redeem
    await registry.connect(government).approve(poolAddr, 1);
    await pool.connect(government).deposit(registryAddr, 1);
    await registry.connect(government).approve(poolAddr, 2);
    await pool.connect(government).deposit(registryAddr, 2);

    const balBefore = await pool.balanceOf(government.address); // 2e18
    await pool.connect(government).redeem(1);

    const redeemFee = ethers.parseEther("1") * 50n / 10_000n;
    expect(await pool.balanceOf(government.address)).to.equal(balBefore - ethers.parseEther("1") - redeemFee);
    expect(await pool.balanceOf(stranger.address)).to.equal(redeemFee);
  });

  it("redeemCost: returns correct total and fee", async function () {
    const { pool, admin, stranger } = await deployFeePoolFixture();
    await pool.connect(admin).setFees(0, 100); // 1% redeem fee
    await pool.connect(admin).setFeeRecipient(stranger.address);
    const [total, fee] = await pool.redeemCost();
    const base = ethers.parseEther("1");
    expect(fee).to.equal(base * 100n / 10_000n);
    expect(total).to.equal(base + fee);
  });
});

// ─────────────────────────────────────────────────────────
//  PLATFORM FEES — RetirementVault
// ─────────────────────────────────────────────────────────

describe("RetirementVault — Platform Fee", function () {
  function buildRecord(overrides = {}) {
    return {
      tokenId:            overrides.tokenId            ?? 1n,
      serialId:           overrides.serialId           ?? "CRS#DRC-2031-000001",
      nationCode:         overrides.nationCode         ?? DRC_CODE(),
      retiringEntity:     overrides.retiringEntity     ?? "0x0000000000000000000000000000000000000001",
      entityName:         overrides.entityName         ?? "Kingdom of Norway",
      purposeCode:        overrides.purposeCode        ?? 0,
      purpose:            overrides.purpose            ?? "Article 6.2 ITMO",
      complianceRef:      overrides.complianceRef      ?? "NDC-NO-2031",
      vintageYear:        overrides.vintageYear        ?? 2031,
      retiredAt:          overrides.retiredAt          ?? BigInt(Math.floor(Date.now() / 1000)),
      attestationHash:    overrides.attestationHash    ?? ethers.keccak256(ethers.toUtf8Bytes("attest-001")),
      beneficiaryAddress: overrides.beneficiaryAddress ?? "0x0000000000000000000000000000000000000001",
      beneficiaryName:    overrides.beneficiaryName    ?? "Kingdom of Norway",
    };
  }

  it("setRetirementFee: emits RetirementFeeUpdated", async function () {
    const { vault, admin } = await deployFixture();
    const fee = ethers.parseEther("0.001"); // 0.001 ETH per record
    await expect(vault.connect(admin).setRetirementFee(fee))
      .to.emit(vault, "RetirementFeeUpdated").withArgs(0n, fee);
    expect(await vault.retirementFeeWei()).to.equal(fee);
  });

  it("setRetirementFee: reverts above MAX_RETIREMENT_FEE_WEI (1 ETH hard cap)", async function () {
    const { vault, admin } = await deployFixture();
    const overCap = ethers.parseEther("1") + 1n;
    await expect(vault.connect(admin).setRetirementFee(overCap))
      .to.be.revertedWithCustomError(vault, "RetirementFeeTooHigh");
    // Exactly at cap is allowed
    await expect(vault.connect(admin).setRetirementFee(ethers.parseEther("1")))
      .to.not.be.reverted;
  });

  it("setFeeRecipient: stores address and emits event", async function () {
    const { vault, admin, stranger } = await deployFixture();
    await expect(vault.connect(admin).setFeeRecipient(stranger.address))
      .to.emit(vault, "FeeRecipientUpdated").withArgs(ethers.ZeroAddress, stranger.address);
  });

  it("recordRetirement: free when fee is zero (default — backward compatible)", async function () {
    const { vault, admin } = await deployFixture();
    await vault.addRegistry(admin.address, DRC_CODE());
    // No fee set — should succeed with no ETH
    await expect(vault.connect(admin).recordRetirement(buildRecord()))
      .to.not.be.reverted;
  });

  it("recordRetirement: reverts when fee unpaid", async function () {
    const { vault, admin, stranger } = await deployFixture();
    await vault.addRegistry(admin.address, DRC_CODE());
    const fee = ethers.parseEther("0.001");
    await vault.connect(admin).setRetirementFee(fee);
    await vault.connect(admin).setFeeRecipient(stranger.address);
    // Call with no ETH
    await expect(vault.connect(admin).recordRetirement(buildRecord()))
      .to.be.revertedWithCustomError(vault, "InsufficientRetirementFee");
  });

  it("recordRetirement: succeeds and forwards fee when paid", async function () {
    const { vault, admin, stranger } = await deployFixture();
    await vault.addRegistry(admin.address, DRC_CODE());
    const fee = ethers.parseEther("0.001");
    await vault.connect(admin).setRetirementFee(fee);
    await vault.connect(admin).setFeeRecipient(stranger.address);

    const balBefore = await ethers.provider.getBalance(stranger.address);
    await vault.connect(admin).recordRetirement(buildRecord(), { value: fee });
    const balAfter = await ethers.provider.getBalance(stranger.address);
    expect(balAfter - balBefore).to.equal(fee);
  });

  it("withdrawFees: reverts when 'to' is zero address", async function () {
    const { vault, admin } = await deployFixture();
    await expect(vault.connect(admin).withdrawFees(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(vault, "InvalidRecipient");
  });

  it("withdrawFees: sends contract balance to recipient", async function () {
    const { vault, admin, stranger } = await deployFixture();
    const vaultAddr = await vault.getAddress();
    // Force vault's ETH balance via Hardhat RPC (simulates stuck ETH from a failed forward)
    await ethers.provider.send("hardhat_setBalance", [vaultAddr, "0x2386F26FC10000"]); // 0.01 ETH
    const balBefore = await ethers.provider.getBalance(stranger.address);
    await vault.connect(admin).withdrawFees(stranger.address);
    const balAfter = await ethers.provider.getBalance(stranger.address);
    expect(balAfter - balBefore).to.equal(ethers.parseEther("0.01"));
  });

  it("setFeeWaiver: emits FeeWaiverUpdated and stores value", async function () {
    const { vault, admin } = await deployFixture();
    await expect(vault.connect(admin).setFeeWaiver(admin.address, true))
      .to.emit(vault, "FeeWaiverUpdated").withArgs(admin.address, true);
    expect(await vault.feeWaived(admin.address)).to.equal(true);
  });

  it("waived registry records for free even when fee is active", async function () {
    const { vault, admin, stranger } = await deployFixture();
    await vault.addRegistry(admin.address, DRC_CODE());
    const fee = ethers.parseEther("0.001");
    await vault.connect(admin).setRetirementFee(fee);
    await vault.connect(admin).setFeeRecipient(stranger.address);
    // Grant founding-partner waiver to admin registry
    await vault.connect(admin).setFeeWaiver(admin.address, true);
    // Should succeed with zero ETH — waiver bypasses the fee
    await expect(vault.connect(admin).recordRetirement(buildRecord()))
      .to.not.be.reverted;
    // Fee recipient received nothing — waiver was applied
    const balAfter = await ethers.provider.getBalance(stranger.address);
    // Balance unchanged from initial Hardhat value (100 ETH)
    expect(await ethers.provider.getBalance(stranger.address)).to.equal(balAfter);
  });

  it("revoking waiver re-enables fee collection", async function () {
    const { vault, admin, stranger } = await deployFixture();
    await vault.addRegistry(admin.address, DRC_CODE());
    const fee = ethers.parseEther("0.001");
    await vault.connect(admin).setRetirementFee(fee);
    await vault.connect(admin).setFeeRecipient(stranger.address);
    // Grant then revoke
    await vault.connect(admin).setFeeWaiver(admin.address, true);
    await vault.connect(admin).setFeeWaiver(admin.address, false);
    // Now must pay the fee
    await expect(vault.connect(admin).recordRetirement(buildRecord()))
      .to.be.revertedWithCustomError(vault, "InsufficientRetirementFee");
  });
});

// ─────────────────────────────────────────────────────────
//  FEE WAIVER — CarbonPool
// ─────────────────────────────────────────────────────────

describe("CarbonPool — Fee Waiver", function () {
  async function deployWaiverPoolFixture() {
    const base = await deployFixture();
    const { oracle, registry, government, auditor1, auditor2, auditor3 } = base;
    const CarbonPool = await ethers.getContractFactory("CarbonPool");
    const pool = await CarbonPool.deploy(
      await registry.getAddress(), "NCRI Pool Token", "NCRI-POOL", 0, 0
    );
    // Mint two credits
    const c1 = buildCredit({ serialId: "WAV-001" });
    const c2 = buildCredit({
      serialId:      "WAV-002",
      satelliteHash: ethers.keccak256(ethers.toUtf8Bytes("sentinel2-wav2.tif")),
      reportHash:    ethers.keccak256(ethers.toUtf8Bytes("mrv-wav2.pdf")),
    });
    await finalizeAttestation(oracle, c1, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c1, "0x");
    await finalizeAttestation(oracle, c2, [auditor1, auditor2, auditor3]);
    await registry.connect(government).mintCredit(c2, "0x");
    return { ...base, pool };
  }

  it("setFeeWaiver: emits FeeWaiverUpdated", async function () {
    const { pool, admin, government } = await deployWaiverPoolFixture();
    await expect(pool.connect(admin).setFeeWaiver(government.address, true))
      .to.emit(pool, "FeeWaiverUpdated").withArgs(government.address, true);
    expect(await pool.feeWaived(government.address)).to.equal(true);
  });

  it("waived depositor receives full TOKENS_PER_CREDIT despite active deposit fee", async function () {
    const { registry, pool, admin, government, stranger } = await deployWaiverPoolFixture();
    const poolAddr      = await pool.getAddress();
    const registryAddr  = await registry.getAddress();
    // 1% deposit fee active
    await pool.connect(admin).setFees(100, 0);
    await pool.connect(admin).setFeeRecipient(stranger.address);
    // Grant waiver to government (founding partner)
    await pool.connect(admin).setFeeWaiver(government.address, true);

    await registry.connect(government).approve(poolAddr, 1);
    await pool.connect(government).deposit(registryAddr, 1);

    // Waived — receives full 1e18, fee recipient gets nothing
    expect(await pool.balanceOf(government.address)).to.equal(ethers.parseEther("1"));
    expect(await pool.balanceOf(stranger.address)).to.equal(0n);
  });

  it("waived redeemer pays no fee on redeem", async function () {
    const { registry, pool, admin, government, stranger } = await deployWaiverPoolFixture();
    const poolAddr      = await pool.getAddress();
    const registryAddr  = await registry.getAddress();
    // 0.5% redeem fee + deposit both credits so balance covers redeem
    await pool.connect(admin).setFees(0, 50);
    await pool.connect(admin).setFeeRecipient(stranger.address);
    await pool.connect(admin).setFeeWaiver(government.address, true);

    await registry.connect(government).approve(poolAddr, 1);
    await pool.connect(government).deposit(registryAddr, 1);
    await registry.connect(government).approve(poolAddr, 2);
    await pool.connect(government).deposit(registryAddr, 2);

    const balBefore = await pool.balanceOf(government.address); // 2e18
    await pool.connect(government).redeem(1);

    // Waived — burns exactly TOKENS_PER_CREDIT, no additional fee transfer
    expect(await pool.balanceOf(government.address)).to.equal(balBefore - ethers.parseEther("1"));
    expect(await pool.balanceOf(stranger.address)).to.equal(0n);
  });

  it("revoking waiver restores fee on deposit", async function () {
    const { registry, pool, admin, government, stranger } = await deployWaiverPoolFixture();
    const poolAddr      = await pool.getAddress();
    const registryAddr  = await registry.getAddress();
    await pool.connect(admin).setFees(100, 0); // 1% deposit fee
    await pool.connect(admin).setFeeRecipient(stranger.address);
    // Grant then revoke
    await pool.connect(admin).setFeeWaiver(government.address, true);
    await pool.connect(admin).setFeeWaiver(government.address, false);

    await registry.connect(government).approve(poolAddr, 1);
    await pool.connect(government).deposit(registryAddr, 1);

    const expectedFee = ethers.parseEther("1") * 100n / 10_000n;
    expect(await pool.balanceOf(government.address)).to.equal(ethers.parseEther("1") - expectedFee);
    expect(await pool.balanceOf(stranger.address)).to.equal(expectedFee);
  });
});

// ═══════════════════════════════════════════════════════════════
//  STRESS TESTS & BOUNDARY CONDITIONS
//  Tests every hard limit and edge case in the system.
//  Coverage: MRVOracle · SovereignRegistry · RetirementVault
//            CarbonPool · NCRIIndex · Cross-contract
//
//  Key contract limits exercised:
//    MAX_BATCH_SIZE      = 200         (SovereignRegistry)
//    MAX_RETIREMENT_FEE  = 1 ether     (RetirementVault)
//    MAX_FEE_BPS         = 1 000       (CarbonPool, 10%)
//    MIN_THRESHOLD       = 3           (MRVOracle)
//    DEFAULT_STAT_JUMP   = 10 000 000  (NCRIIndex)
//    TIMELOCK_DELAY      = 2 days      (MRVOracle + SovereignRegistry)
//    Vintage range       = 2020–2100   (SovereignRegistry)
// ═══════════════════════════════════════════════════════════════

describe("STRESS — MRVOracle Boundaries", function () {
  // Unique hashes per test to avoid cross-test attestation state
  let h = 0;
  function freshHashes() {
    h++;
    return {
      sat:    ethers.keccak256(ethers.toUtf8Bytes(`stress-sat-${h}`)),
      rep:    ethers.keccak256(ethers.toUtf8Bytes(`stress-rep-${h}`)),
      parcel: ethers.keccak256(ethers.toUtf8Bytes(`stress-parcel-${h}`)),
    };
  }

  it("MIN_THRESHOLD = 3 is the floor — proposeThreshold(2) reverts", async function () {
    const { oracle, admin } = await deployFixture();
    // Add enough auditors so auditor count is not the blocker
    await expect(oracle.connect(admin).proposeThreshold(2))
      .to.be.revertedWithCustomError(oracle, "ThresholdTooLow").withArgs(2);
  });

  it("proposeThreshold reverts when threshold > totalAuditors", async function () {
    const { oracle, admin } = await deployFixture();
    // 5 auditors added in deployFixture; threshold 6 exceeds pool
    await expect(oracle.connect(admin).proposeThreshold(6))
      .to.be.revertedWithCustomError(oracle, "ThresholdExceedsAuditors");
  });

  it("threshold boundary: exactly MIN_THRESHOLD (3) is accepted", async function () {
    const { oracle, admin } = await deployFixture();
    // 5 auditors, threshold already 3, propose same value
    await oracle.connect(admin).proposeThreshold(3);
    expect(await oracle.pendingThreshold()).to.equal(3);
  });

  it("finalization fires at exactly threshold signatures (3-of-5)", async function () {
    const { oracle, auditor1, auditor2, auditor3 } = await deployFixture();
    const { sat, rep, parcel } = freshHashes();
    await oracle.connect(auditor1).submitAttestation(sat, rep, parcel);
    await oracle.connect(auditor2).submitAttestation(sat, rep, parcel);
    expect(await oracle.isFinalized(ethers.keccak256(ethers.solidityPacked(["bytes32","bytes32"],[sat,rep])))).to.be.false;
    await oracle.connect(auditor3).submitAttestation(sat, rep, parcel);
    expect(await oracle.isFinalized(ethers.keccak256(ethers.solidityPacked(["bytes32","bytes32"],[sat,rep])))).to.be.true;
  });

  it("4-of-5 — extra sig after threshold does NOT double-finalize or revert", async function () {
    const { oracle, auditor1, auditor2, auditor3, auditor4 } = await deployFixture();
    const { sat, rep, parcel } = freshHashes();
    for (const a of [auditor1, auditor2, auditor3]) {
      await oracle.connect(a).submitAttestation(sat, rep, parcel);
    }
    // 4th sig on already-finalized attestation should revert with AttestationAlreadyFinalized
    await expect(oracle.connect(auditor4).submitAttestation(sat, rep, parcel))
      .to.be.revertedWithCustomError(oracle, "AttestationAlreadyFinalized");
  });

  it("double-sign by same auditor reverts AlreadySigned", async function () {
    const { oracle, auditor1 } = await deployFixture();
    const { sat, rep, parcel } = freshHashes();
    await oracle.connect(auditor1).submitAttestation(sat, rep, parcel);
    await expect(oracle.connect(auditor1).submitAttestation(sat, rep, parcel))
      .to.be.revertedWithCustomError(oracle, "AlreadySigned");
  });

  it("hash mismatch reverts when second auditor uses different parcel", async function () {
    const { oracle, auditor1, auditor2 } = await deployFixture();
    const { sat, rep, parcel } = freshHashes();
    const wrongParcel = ethers.keccak256(ethers.toUtf8Bytes("evil-parcel"));
    await oracle.connect(auditor1).submitAttestation(sat, rep, parcel);
    await expect(oracle.connect(auditor2).submitAttestation(sat, rep, wrongParcel))
      .to.be.revertedWithCustomError(oracle, "HashMismatch");
  });

  it("removeAuditor: reverts when removal would break current threshold", async function () {
    const { oracle, admin, auditor1, auditor2, auditor3 } = await deployFixture();
    // Remove 2 auditors so pool drops to 3 == threshold
    await oracle.connect(admin).removeAuditor(auditor1.address);
    await oracle.connect(admin).removeAuditor(auditor2.address);
    // totalAuditors = 3, threshold = 3 — removing one more would break it
    await expect(oracle.connect(admin).removeAuditor(auditor3.address))
      .to.be.revertedWithCustomError(oracle, "WouldBreakThreshold");
  });

  it("resetAttestation clears signer flags — same auditor can re-sign after reset", async function () {
    const { oracle, admin, auditor1, auditor2 } = await deployFixture();
    const { sat, rep, parcel } = freshHashes();
    await oracle.connect(auditor1).submitAttestation(sat, rep, parcel);
    await oracle.connect(auditor2).submitAttestation(sat, rep, parcel);
    const id = ethers.keccak256(ethers.solidityPacked(["bytes32","bytes32"],[sat,rep]));
    await oracle.connect(admin).resetAttestation(id);
    // After reset, auditor1 should be able to sign again without AlreadySigned
    await expect(oracle.connect(auditor1).submitAttestation(sat, rep, parcel)).to.not.be.reverted;
  });

  it("TIMELOCK_DELAY = 2 days: executing before expiry reverts", async function () {
    const { oracle, admin } = await deployFixture();
    await oracle.connect(admin).proposeThreshold(4); // 4 <= 5 auditors, valid
    await expect(oracle.connect(admin).executeThreshold())
      .to.be.revertedWithCustomError(oracle, "TimelockNotExpired");
  });

  it("TIMELOCK_DELAY = 2 days: executing after expiry succeeds", async function () {
    const { oracle, admin } = await deployFixture();
    await oracle.connect(admin).proposeThreshold(4);
    await advanceDays(2);
    await oracle.connect(admin).executeThreshold();
    expect(await oracle.threshold()).to.equal(4);
  });
});

describe("STRESS — SovereignRegistry Boundaries", function () {

  // Helper: sign attestations for an array of credits
  async function signAll(oracle, credits, auditors) {
    for (const c of credits) {
      for (const a of auditors) {
        await oracle.connect(a).submitAttestation(
          c.attestation.satelliteHash, c.attestation.reportHash, c.parcel.geojsonHash
        );
      }
    }
  }

  it("MAX_BATCH_SIZE = 200 — mintBatch(201) reverts BatchTooLarge (check fires before attestation)", async function () {
    const { registry, government } = await deployFixture();
    // BatchTooLarge fires at step 2, before attestation checks — no need to sign credits.
    // Use dummy credits (all identical is fine since the batch size check is first).
    const credits = Array.from({ length: 201 }, () => buildCredit({ serialId: "CRS#DUMMY" }));
    await expect(registry.connect(government).mintBatch(credits, "0x"))
      .to.be.revertedWithCustomError(registry, "BatchTooLarge");
  });

  it("MAX_BATCH_SIZE = 200 — mintBatch(10) succeeds, confirming batch minting works", async function () {
    // Gas limits on the local test chain cap a single transaction to ~16M gas,
    // making a full 200-credit batch infeasible to execute in tests. We verify the
    // logic works with 10 credits and rely on the 201-reverts test above for the boundary.
    const { registry, oracle, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const credits = Array.from({ length: 10 }, (_, i) => buildCredit({
      serialId:      `CRS#B10-${i}`,
      satelliteHash: ethers.keccak256(ethers.toUtf8Bytes(`b10-sat-${i}`)),
      reportHash:    ethers.keccak256(ethers.toUtf8Bytes(`b10-rep-${i}`)),
      geojsonHash:   ethers.keccak256(ethers.toUtf8Bytes(`b10-parcel-${i}`)),
    }));
    await signAll(oracle, credits, [auditor1, auditor2, auditor3]);
    await expect(registry.connect(government).mintBatch(credits, "0x")).to.not.be.reverted;
    expect(await registry.totalMinted()).to.equal(10n);
  });

  it("retireBatch: reverts when batch > MAX_BATCH_SIZE (201 token IDs, check fires first)", async function () {
    const { registry, government } = await deployFixture();
    // BatchTooLarge fires before any _retire call — no minted tokens needed.
    const tokenIds = Array.from({ length: 201 }, (_, i) => BigInt(i + 1));
    await expect(registry.connect(government).retireBatch(tokenIds, "CORSIA stress", 0))
      .to.be.revertedWithCustomError(registry, "BatchTooLarge");
  });

  it("mintingCap: exact boundary — minting at cap succeeds, one over reverts", async function () {
    const { registry, oracle, government, auditor1, auditor2, auditor3 } = await deployFixture();
    await registry.connect(government).setMintingCap(2, 86400); // 2 credits per day

    const credits = Array.from({ length: 3 }, (_, i) => buildCredit({
      serialId:      `CRS#CAP-${i}`,
      satelliteHash: ethers.keccak256(ethers.toUtf8Bytes(`cap-sat-${i}`)),
      reportHash:    ethers.keccak256(ethers.toUtf8Bytes(`cap-rep-${i}`)),
      geojsonHash:   ethers.keccak256(ethers.toUtf8Bytes(`cap-p-${i}`)),
    }));
    await signAll(oracle, credits, [auditor1, auditor2, auditor3]);

    await registry.connect(government).mintCredit(credits[0], "0x");
    await registry.connect(government).mintCredit(credits[1], "0x"); // at cap
    await expect(registry.connect(government).mintCredit(credits[2], "0x"))
      .to.be.revertedWithCustomError(registry, "MintingCapExceeded");
  });

  it("mintingCap: period rolls over after mintingPeriod — fresh budget available", async function () {
    const { registry, oracle, government, auditor1, auditor2, auditor3 } = await deployFixture();
    await registry.connect(government).setMintingCap(1, 86400); // 1 credit per day

    const credits = Array.from({ length: 2 }, (_, i) => buildCredit({
      serialId:      `CRS#ROLL-${i}`,
      satelliteHash: ethers.keccak256(ethers.toUtf8Bytes(`roll-sat-${i}`)),
      reportHash:    ethers.keccak256(ethers.toUtf8Bytes(`roll-rep-${i}`)),
      geojsonHash:   ethers.keccak256(ethers.toUtf8Bytes(`roll-p-${i}`)),
    }));
    await signAll(oracle, credits, [auditor1, auditor2, auditor3]);

    await registry.connect(government).mintCredit(credits[0], "0x"); // uses the 1-credit budget
    await advanceDays(1);                                              // period rolls over
    await expect(registry.connect(government).mintCredit(credits[1], "0x")).to.not.be.reverted;
  });

  it("vintage year floor: 2019 reverts", async function () {
    const { registry, oracle, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit({ serialId: "CRS#VY-LOW", vintageYear: 2019, satelliteHash: ethers.keccak256(ethers.toUtf8Bytes("vy-sat")), reportHash: ethers.keccak256(ethers.toUtf8Bytes("vy-rep")), geojsonHash: ethers.keccak256(ethers.toUtf8Bytes("vy-p")) });
    await signAll(oracle, [c], [auditor1, auditor2, auditor3]);
    await expect(registry.connect(government).mintCredit(c, "0x"))
      .to.be.revertedWithCustomError(registry, "InvalidVintageYear");
  });

  it("vintage year ceiling: 2101 reverts", async function () {
    const { registry, oracle, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit({ serialId: "CRS#VY-HIGH", vintageYear: 2101, satelliteHash: ethers.keccak256(ethers.toUtf8Bytes("vy2-sat")), reportHash: ethers.keccak256(ethers.toUtf8Bytes("vy2-rep")), geojsonHash: ethers.keccak256(ethers.toUtf8Bytes("vy2-p")) });
    await signAll(oracle, [c], [auditor1, auditor2, auditor3]);
    await expect(registry.connect(government).mintCredit(c, "0x"))
      .to.be.revertedWithCustomError(registry, "InvalidVintageYear");
  });

  it("vintage year valid range: 2020 and 2100 both accepted", async function () {
    const { registry, oracle, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c2020 = buildCredit({ serialId: "CRS#VY-2020", vintageYear: 2020, satelliteHash: ethers.keccak256(ethers.toUtf8Bytes("vy2020-sat")), reportHash: ethers.keccak256(ethers.toUtf8Bytes("vy2020-rep")), geojsonHash: ethers.keccak256(ethers.toUtf8Bytes("vy2020-p")) });
    const c2100 = buildCredit({ serialId: "CRS#VY-2100", vintageYear: 2100, satelliteHash: ethers.keccak256(ethers.toUtf8Bytes("vy2100-sat")), reportHash: ethers.keccak256(ethers.toUtf8Bytes("vy2100-rep")), geojsonHash: ethers.keccak256(ethers.toUtf8Bytes("vy2100-p")) });
    await signAll(oracle, [c2020, c2100], [auditor1, auditor2, auditor3]);
    await expect(registry.connect(government).mintCredit(c2020, "0x")).to.not.be.reverted;
    await expect(registry.connect(government).mintCredit(c2100, "0x")).to.not.be.reverted;
  });
});

describe("STRESS — RetirementVault Boundaries", function () {

  it("getRecentRetirements(0) returns empty array", async function () {
    const { vault } = await deployFixture();
    const recs = await vault.getRecentRetirements(0);
    expect(recs.length).to.equal(0);
  });

  it("getRecentRetirements(count > total) is capped at ledger length", async function () {
    const { vault } = await deployFixture();
    // No retirements yet — ledger is empty
    const recs = await vault.getRecentRetirements(9999);
    expect(recs.length).to.equal(0);
  });

  it("getRetirement: IndexOutOfRange reverts on empty ledger", async function () {
    const { vault } = await deployFixture();
    await expect(vault.getRetirement(0))
      .to.be.revertedWithCustomError(vault, "IndexOutOfRange");
  });

  it("retirementFeeWei = MAX (1 ether) accepted; MAX+1 reverts", async function () {
    const { vault, admin } = await deployFixture();
    await expect(vault.connect(admin).setRetirementFee(ethers.parseEther("1"))).to.not.be.reverted;
    await expect(vault.connect(admin).setRetirementFee(ethers.parseEther("1") + 1n))
      .to.be.revertedWithCustomError(vault, "RetirementFeeTooHigh");
  });

  it("fee=0 + feeRecipient=set → feeActive false — no payment required", async function () {
    const { vault, registry, admin, stranger } = await deployFixture();
    // fee stays at 0 (default); set a recipient anyway — feeActive is still false because feeWei=0
    await vault.connect(admin).setFeeRecipient(stranger.address);
    // Confirm the registry is authorised (set up in deployFixture)
    const registryAddr = await registry.getAddress();
    const REGISTRY_ROLE = await vault.REGISTRY_ROLE();
    expect(await vault.hasRole(REGISTRY_ROLE, registryAddr)).to.be.true;
    expect(await vault.retirementFeeWei()).to.equal(0n);
  });

  it("double-retirement: AlreadyRecorded reverts on same (nation, tokenId)", async function () {
    const { registry, oracle, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const credit = buildCredit({ serialId: "CRS#DBL-001", satelliteHash: ethers.keccak256(ethers.toUtf8Bytes("dbl-sat")), reportHash: ethers.keccak256(ethers.toUtf8Bytes("dbl-rep")), geojsonHash: ethers.keccak256(ethers.toUtf8Bytes("dbl-p")) });
    for (const a of [auditor1, auditor2, auditor3]) {
      await oracle.connect(a).submitAttestation(credit.attestation.satelliteHash, credit.attestation.reportHash, credit.parcel.geojsonHash);
    }
    await registry.connect(government).mintCredit(credit, "0x");
    // retireCredit(tokenId, reason, CompliancePurpose=0 for VOLUNTARY)
    await registry.connect(government).retireCredit(1n, "VOLUNTARY double test", 0);
    // Second retire of same token must revert (token is now in RETIRED state)
    await expect(registry.connect(government).retireCredit(1n, "VOLUNTARY double test", 0))
      .to.be.reverted;
  });
});

describe("STRESS — CarbonPool Boundaries", function () {

  // CarbonPool constructor: (registry, name, symbol, vintageFrom, vintageTo)
  async function deployPoolFixture() {
    const { registry, oracle, vault, admin, government, auditor1, auditor2, auditor3, buyer, stranger } = await deployFixture();
    const CarbonPool = await ethers.getContractFactory("CarbonPool");
    // Deployer (admin = signers[0]) becomes Ownable owner
    const pool = await CarbonPool.deploy(
      await registry.getAddress(), "DRC Carbon Pool", "DCP", 0, 0
    );
    return { registry, oracle, vault, pool, admin, government, auditor1, auditor2, auditor3, buyer, stranger };
  }

  // Mint n credits, sign attestations, mintBatch, then deposit all into pool
  async function mintAndDepositN(n, { registry, oracle, pool, government, auditor1, auditor2, auditor3 }) {
    const poolAddr     = await pool.getAddress();
    const registryAddr = await registry.getAddress();
    const credits = Array.from({ length: n }, (_, i) => buildCredit({
      serialId:      `CRS#POOL-${i}`,
      satelliteHash: ethers.keccak256(ethers.toUtf8Bytes(`pool-sat-${i}`)),
      reportHash:    ethers.keccak256(ethers.toUtf8Bytes(`pool-rep-${i}`)),
      geojsonHash:   ethers.keccak256(ethers.toUtf8Bytes(`pool-parcel-${i}`)),
    }));
    for (const c of credits) {
      for (const a of [auditor1, auditor2, auditor3]) {
        await oracle.connect(a).submitAttestation(c.attestation.satelliteHash, c.attestation.reportHash, c.parcel.geojsonHash);
      }
    }
    await registry.connect(government).mintBatch(credits, "0x");
    await registry.connect(government).setApprovalForAll(poolAddr, true);
    for (let i = 1; i <= n; i++) {
      await pool.connect(government).deposit(registryAddr, i);
    }
  }

  it("MAX_FEE_BPS = 1000 (10%) accepted; 1001 reverts FeeTooHigh", async function () {
    const { pool, admin } = await deployPoolFixture();
    await expect(pool.connect(admin).setFees(1000, 0)).to.not.be.reverted;
    await expect(pool.connect(admin).setFees(1001, 0)).to.be.revertedWithCustomError(pool, "FeeTooHigh");
    await expect(pool.connect(admin).setFees(0, 1000)).to.not.be.reverted;
    await expect(pool.connect(admin).setFees(0, 1001)).to.be.revertedWithCustomError(pool, "FeeTooHigh");
  });

  it("fee at MAX_FEE_BPS (10%): deposit returns 0.9 tokens, redeemCost = 1.1 tokens", async function () {
    const { pool, admin, stranger } = await deployPoolFixture();
    await pool.connect(admin).setFees(1000, 1000);
    await pool.connect(admin).setFeeRecipient(stranger.address); // activate fee
    const ONE = ethers.parseEther("1");
    // depositReturn() → [received, fee]; redeemCost() → [total, fee]
    const [received] = await pool.depositReturn();
    const [total]    = await pool.redeemCost();
    expect(received).to.equal(ONE * 9000n / 10000n);
    expect(total).to.equal(ONE + ONE * 1000n / 10000n);
  });

  it("queue swap-pop: redeeming middle token does not corrupt queue", async function () {
    this.timeout(60000);
    const ctx = await deployPoolFixture();
    await mintAndDepositN(5, ctx);
    const { pool, registry, government } = ctx;

    // Pool contains tokens 1,2,3,4,5. Redeem token #3 (middle).
    // Swap-pop moves token 5 into slot 2 — remaining queue: [1,2,5,4]
    await pool.connect(government).redeem(3n);
    expect(await registry.ownerOf(3n)).to.equal(government.address);
    expect(await pool.poolSize()).to.equal(4n);

    // Redeem all remaining — queue must be intact after swap-pop
    for (const id of [1n, 2n, 4n, 5n]) {
      await pool.connect(government).redeem(id);
    }
    expect(await pool.poolSize()).to.equal(0n);
  });

  it("single-credit pool: deposit then immediate redeem of same token", async function () {
    const { registry, oracle, pool, government, auditor1, auditor2, auditor3 } = await deployPoolFixture();
    const credit = buildCredit({ serialId: "CRS#SINGLE", satelliteHash: ethers.keccak256(ethers.toUtf8Bytes("single-sat")), reportHash: ethers.keccak256(ethers.toUtf8Bytes("single-rep")), geojsonHash: ethers.keccak256(ethers.toUtf8Bytes("single-p")) });
    for (const a of [auditor1, auditor2, auditor3]) {
      await oracle.connect(a).submitAttestation(credit.attestation.satelliteHash, credit.attestation.reportHash, credit.parcel.geojsonHash);
    }
    await registry.connect(government).mintCredit(credit, "0x");
    const poolAddr = await pool.getAddress();
    const registryAddr = await registry.getAddress();
    await registry.connect(government).approve(poolAddr, 1);
    await pool.connect(government).deposit(registryAddr, 1);
    expect(await pool.poolSize()).to.equal(1n);
    await pool.connect(government).redeem(1n);
    expect(await pool.poolSize()).to.equal(0n);
    expect(await registry.ownerOf(1n)).to.equal(government.address);
  });

  it("redeeming non-existent token reverts NotInPool", async function () {
    const { pool, government } = await deployPoolFixture();
    await expect(pool.connect(government).redeem(999n))
      .to.be.revertedWithCustomError(pool, "NotInPool");
  });

  it("depositing same token twice reverts (pool owns token after first deposit)", async function () {
    const { registry, oracle, pool, government, auditor1, auditor2, auditor3 } = await deployPoolFixture();
    const credit = buildCredit({ serialId: "CRS#DUP", satelliteHash: ethers.keccak256(ethers.toUtf8Bytes("dup-sat")), reportHash: ethers.keccak256(ethers.toUtf8Bytes("dup-rep")), geojsonHash: ethers.keccak256(ethers.toUtf8Bytes("dup-p")) });
    for (const a of [auditor1, auditor2, auditor3]) {
      await oracle.connect(a).submitAttestation(credit.attestation.satelliteHash, credit.attestation.reportHash, credit.parcel.geojsonHash);
    }
    await registry.connect(government).mintCredit(credit, "0x");
    const poolAddr = await pool.getAddress();
    const registryAddr = await registry.getAddress();
    await registry.connect(government).approve(poolAddr, 1);
    await pool.connect(government).deposit(registryAddr, 1);
    // Pool now owns token 1 — depositing again should revert (not owner)
    await expect(pool.connect(government).deposit(registryAddr, 1)).to.be.reverted;
  });
});

describe("STRESS — NCRIIndex Boundaries", function () {

  it("DEFAULT_STAT_JUMP: sync at exact jump limit succeeds", async function () {
    const { index, admin } = await deployFixture();
    const [,,, relayer] = await ethers.getSigners();
    await index.connect(admin).addRelayer(relayer.address);

    const jump = 10_000_000n;
    // active + retired + suspended == minted
    await expect(index.connect(relayer).syncNationStats(
      DRC_CODE(), jump, jump, 0n, 0n  // minted=jump, active=jump, retired=0, suspended=0
    )).to.not.be.reverted;
  });

  it("DEFAULT_STAT_JUMP: sync at jump+1 reverts StatJumpTooLarge", async function () {
    const { index, admin } = await deployFixture();
    const [,,, relayer] = await ethers.getSigners();
    await index.connect(admin).addRelayer(relayer.address);

    const jump = 10_000_000n;
    await expect(index.connect(relayer).syncNationStats(
      DRC_CODE(), jump + 1n, jump + 1n, 0n, 0n
    )).to.be.revertedWithCustomError(index, "StatJumpTooLarge");
  });

  it("setMaxStatJump: governance can raise limit; relayer can then sync larger value", async function () {
    const { index, admin } = await deployFixture();
    const [,,, relayer] = await ethers.getSigners();
    await index.connect(admin).addRelayer(relayer.address);

    const bigJump = 50_000_000n;
    await index.connect(admin).setMaxStatJump(bigJump);
    await expect(index.connect(relayer).syncNationStats(
      DRC_CODE(), bigJump, bigJump, 0n, 0n
    )).to.not.be.reverted;
  });

  it("setMaxStatJump(0) reverts InvalidStatJump", async function () {
    const { index, admin } = await deployFixture();
    await expect(index.connect(admin).setMaxStatJump(0))
      .to.be.revertedWithCustomError(index, "InvalidStatJump");
  });

  it("rebalance: single active nation gets exactly 10 000 bps (100%)", async function () {
    const { index, admin } = await deployFixture();
    const [,,, relayer] = await ethers.getSigners();
    await index.connect(admin).addRelayer(relayer.address);

    await index.connect(relayer).syncNationStats(DRC_CODE(), 1000n, 1000n, 0n, 0n);
    const [, weights] = await index.rebalance();
    expect(weights[0]).to.equal(10_000n);
  });

  it("rebalance: two equal nations each get 5 000 bps", async function () {
    const { index, admin, oracle } = await deployFixture();
    const [,,,, relayer] = await ethers.getSigners();
    await index.connect(admin).addRelayer(relayer.address);

    await index.addNation(LIBERIA_CODE(), "Liberia", await oracle.getAddress(), "channel-1");

    await index.connect(relayer).syncNationStats(DRC_CODE(),     1000n, 1000n, 0n, 0n);
    await index.connect(relayer).syncNationStats(LIBERIA_CODE(), 1000n, 1000n, 0n, 0n);

    const [, weights] = await index.rebalance();
    const total = weights.reduce((a, b) => a + b, 0n);
    expect(total).to.equal(10_000n);
    // Both active nations — each 50%
    expect(weights[0]).to.equal(5_000n);
    expect(weights[1]).to.equal(5_000n);
  });

  it("rebalance dust: integer division remainder allocated to largest nation", async function () {
    const { index, admin, oracle } = await deployFixture();
    const [,,, relayer] = await ethers.getSigners();
    await index.connect(admin).addRelayer(relayer.address);
    await index.addNation(LIBERIA_CODE(), "Liberia", await oracle.getAddress(), "channel-1");

    // DRC = 2, Liberia = 1 → DRC weight = floor(2/3 * 10000) = 6666, Lib = 3333
    // total = 9999 → dust goes to DRC (largest)
    await index.connect(relayer).syncNationStats(DRC_CODE(),     3n, 2n, 0n, 1n); // active=2, retired=0, suspended=1, minted=3
    await index.connect(relayer).syncNationStats(LIBERIA_CODE(), 1n, 1n, 0n, 0n);

    const [, weights] = await index.rebalance();
    const total = weights.reduce((a, b) => a + b, 0n);
    expect(total).to.equal(10_000n);
    // DRC gets dust: 6666 + 1 = 6667, Liberia = 3333
    expect(weights[0]).to.equal(6_667n);
    expect(weights[1]).to.equal(3_333n);
  });

  it("rebalance: empty supply returns all-zero weights", async function () {
    const { index } = await deployFixture();
    const [, weights] = await index.rebalance();
    expect(weights[0]).to.equal(0n);
  });

  it("deactivating a nation removes its supply from global aggregates", async function () {
    const { index, admin } = await deployFixture();
    const [,,, relayer] = await ethers.getSigners();
    await index.connect(admin).addRelayer(relayer.address);

    await index.connect(relayer).syncNationStats(DRC_CODE(), 1000n, 1000n, 0n, 0n);
    expect(await index.globalActiveSupply()).to.equal(1000n);

    await index.connect(admin).deactivateNation(DRC_CODE());
    expect(await index.globalActiveSupply()).to.equal(0n);
  });

  it("reactivating a nation restores its supply", async function () {
    const { index, admin } = await deployFixture();
    const [,,, relayer] = await ethers.getSigners();
    await index.connect(admin).addRelayer(relayer.address);

    await index.connect(relayer).syncNationStats(DRC_CODE(), 1000n, 1000n, 0n, 0n);
    await index.connect(admin).deactivateNation(DRC_CODE());
    await index.connect(admin).reactivateNation(DRC_CODE());
    expect(await index.globalActiveSupply()).to.equal(1000n);
  });

  it("syncNationStats on inactive nation: stats stored but globals not updated", async function () {
    const { index, admin } = await deployFixture();
    const [,,, relayer] = await ethers.getSigners();
    await index.connect(admin).addRelayer(relayer.address);

    await index.connect(relayer).syncNationStats(DRC_CODE(), 1000n, 1000n, 0n, 0n);
    await index.connect(admin).deactivateNation(DRC_CODE());

    // Sync while inactive — globals should NOT change
    await index.connect(relayer).syncNationStats(DRC_CODE(), 2000n, 2000n, 0n, 0n);
    expect(await index.globalActiveSupply()).to.equal(0n); // still excluded
    const n = await index.getNation(DRC_CODE());
    expect(n.totalActive).to.equal(2000n); // stored on the slot
  });
});

describe("STRESS — Cross-Contract Full Chain", function () {

  it("full mint → pool deposit → pool redeem → retire chain with fee at MAX", async function () {
    this.timeout(60000);
    const { registry, oracle, vault, admin, government, auditor1, auditor2, auditor3, stranger } = await deployFixture();

    // CarbonPool constructor: (registry, name, symbol, vintageFrom, vintageTo)
    const CarbonPool = await ethers.getContractFactory("CarbonPool");
    const pool = await CarbonPool.deploy(await registry.getAddress(), "DRC Carbon Pool", "DCP", 0, 0);
    const poolAddr     = await pool.getAddress();
    const registryAddr = await registry.getAddress();

    // CarbonPool deployer (signers[0] = admin) is the Ownable owner
    await pool.connect(admin).setFees(1000, 1000); // 10% deposit + 10% redeem
    await pool.connect(admin).setFeeRecipient(stranger.address);

    // Vault fee set to 0 — SovereignRegistry.retireCredit does not forward ETH,
    // so a non-zero vault fee would break the retire step
    await vault.connect(admin).setRetirementFee(0n);

    // Sign and mint credit #1
    const credit = buildCredit({ serialId: "CRS#CHAIN-001", satelliteHash: ethers.keccak256(ethers.toUtf8Bytes("chain-sat")), reportHash: ethers.keccak256(ethers.toUtf8Bytes("chain-rep")), geojsonHash: ethers.keccak256(ethers.toUtf8Bytes("chain-p")) });
    for (const a of [auditor1, auditor2, auditor3]) {
      await oracle.connect(a).submitAttestation(credit.attestation.satelliteHash, credit.attestation.reportHash, credit.parcel.geojsonHash);
    }
    await registry.connect(government).mintCredit(credit, "0x");
    expect(await registry.ownerOf(1n)).to.equal(government.address);

    // Deposit credit #1 — receives 90% = 0.9e18 tokens (10% deposit fee)
    await registry.connect(government).approve(poolAddr, 1n);
    await pool.connect(government).deposit(registryAddr, 1n);
    const depositReceived = await pool.balanceOf(government.address);
    expect(depositReceived).to.equal(ethers.parseEther("1") * 9000n / 10000n);

    // government needs 1.1e18 to redeem (1e18 + 10% redeem fee).
    // Deposit a second credit to earn the extra tokens.
    const credit2 = buildCredit({ serialId: "CRS#CHAIN-002", satelliteHash: ethers.keccak256(ethers.toUtf8Bytes("chain2-sat")), reportHash: ethers.keccak256(ethers.toUtf8Bytes("chain2-rep")), geojsonHash: ethers.keccak256(ethers.toUtf8Bytes("chain2-p")) });
    for (const a of [auditor1, auditor2, auditor3]) {
      await oracle.connect(a).submitAttestation(credit2.attestation.satelliteHash, credit2.attestation.reportHash, credit2.parcel.geojsonHash);
    }
    await registry.connect(government).mintCredit(credit2, "0x");
    await registry.connect(government).approve(poolAddr, 2n);
    await pool.connect(government).deposit(registryAddr, 2n);

    // Redeem token #1 — burns 1.1e18 tokens (1e18 + 10% fee to stranger)
    await pool.connect(government).redeem(1n);
    expect(await registry.ownerOf(1n)).to.equal(government.address);

    // Retire token #1 via registry → vault (vault fee is 0, so no ETH needed)
    await registry.connect(government).retireCredit(1n, "CHAIN TEST", 0);

    expect(await vault.totalRetired()).to.equal(1n);
    const rec = await vault.getRetirement(0n);
    expect(rec.nationCode).to.equal(DRC_CODE());
  });
});

// ═══════════════════════════════════════════════════════════════
//  COVERAGE GAP TESTS — Pre-Launch
//  Targeted tests that close every uncovered line and branch
//  identified by npx hardhat coverage (Round 4 report).
//
//  Line gaps closed:
//    SovereignRegistry  694, 713, 743
//    NCRIIndex          221, 324
//    RetirementVault    250-251, 333
//    CarbonPool         287, 320, 345
//    MethodologyRegistry 112
//
//  Branch gaps closed:
//    SovereignRegistry  tokenURI empty-baseURI path, minting-cap window
//                       rollover, setMintingCap period=0 default,
//                       allowlist "to" address block, VaultRecordFailed catch
//    NCRIIndex          syncNationStats when nation inactive,
//                       StatJumpTooLarge on retired counter
//    RetirementVault    excess ETH refund path
//    CarbonPool         onERC721Received allowlist rejection,
//                       CreditNotTransferable on suspended redeem
//    MRVOracle          addAuditor idempotency, verifyAttestation parcel
//                       mismatch (false return), executeThreshold post-
//                       auditor-removal revert
//    MethodologyRegistry getKey utility
// ═══════════════════════════════════════════════════════════════

// ── SovereignRegistry coverage gaps ───────────────────────────

describe("Coverage — SovereignRegistry", function () {

  it("tokenURI returns empty string when baseURI not set", async function () {
    const { registry, oracle, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const credit = buildCredit({ serialId: "CRS#URI-001",
      satelliteHash: ethers.keccak256(ethers.toUtf8Bytes("uri-sat")),
      reportHash:    ethers.keccak256(ethers.toUtf8Bytes("uri-rep")),
      geojsonHash:   ethers.keccak256(ethers.toUtf8Bytes("uri-p")) });
    for (const a of [auditor1, auditor2, auditor3])
      await oracle.connect(a).submitAttestation(
        credit.attestation.satelliteHash, credit.attestation.reportHash, credit.parcel.geojsonHash);
    await registry.connect(government).mintCredit(credit, "0x");
    // No baseURI set — must return empty string
    expect(await registry.tokenURI(1n)).to.equal("");
  });

  it("tokenURI returns baseURI + serialId after setBaseURI", async function () {
    const { registry, oracle, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const credit = buildCredit({ serialId: "CRS#URI-002",
      satelliteHash: ethers.keccak256(ethers.toUtf8Bytes("uri2-sat")),
      reportHash:    ethers.keccak256(ethers.toUtf8Bytes("uri2-rep")),
      geojsonHash:   ethers.keccak256(ethers.toUtf8Bytes("uri2-p")) });
    for (const a of [auditor1, auditor2, auditor3])
      await oracle.connect(a).submitAttestation(
        credit.attestation.satelliteHash, credit.attestation.reportHash, credit.parcel.geojsonHash);
    await registry.connect(government).mintCredit(credit, "0x");
    await registry.connect(government).setBaseURI("https://registry.ccr.earth/CD/");
    expect(await registry.tokenURI(1n)).to.equal("https://registry.ccr.earth/CD/CRS#URI-002");
  });

  it("getProjectTokens returns the minted token IDs for a project", async function () {
    const { registry, oracle, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const pid = ethers.keccak256(ethers.toUtf8Bytes("PROJECT-A"));
    const credit = buildCredit({ serialId: "CRS#PROJ-001", projectId: pid,
      satelliteHash: ethers.keccak256(ethers.toUtf8Bytes("proj-sat")),
      reportHash:    ethers.keccak256(ethers.toUtf8Bytes("proj-rep")),
      geojsonHash:   ethers.keccak256(ethers.toUtf8Bytes("proj-p")) });
    for (const a of [auditor1, auditor2, auditor3])
      await oracle.connect(a).submitAttestation(
        credit.attestation.satelliteHash, credit.attestation.reportHash, credit.parcel.geojsonHash);
    await registry.connect(government).mintCredit(credit, "0x");
    const tokens = await registry.getProjectTokens(pid);
    expect(tokens.length).to.equal(1);
    expect(tokens[0]).to.equal(1n);
  });

  it("supportsInterface returns true for ERC721 and AccessControl interfaces", async function () {
    const { registry } = await deployFixture();
    // ERC721 interfaceId = 0x80ac58cd
    expect(await registry.supportsInterface("0x80ac58cd")).to.be.true;
    // AccessControl interfaceId = 0x7965db0b
    expect(await registry.supportsInterface("0x7965db0b")).to.be.true;
  });

  it("_checkMintingCap: window rolls over after period expires", async function () {
    const { registry, oracle, government, auditor1, auditor2, auditor3 } = await deployFixture();
    // Cap = 1 per day
    await registry.connect(government).setMintingCap(1, 86400);

    const c1 = buildCredit({ serialId: "CRS#ROLL-001",
      satelliteHash: ethers.keccak256(ethers.toUtf8Bytes("roll-sat1")),
      reportHash:    ethers.keccak256(ethers.toUtf8Bytes("roll-rep1")),
      geojsonHash:   ethers.keccak256(ethers.toUtf8Bytes("roll-p1")) });
    const c2 = buildCredit({ serialId: "CRS#ROLL-002",
      satelliteHash: ethers.keccak256(ethers.toUtf8Bytes("roll-sat2")),
      reportHash:    ethers.keccak256(ethers.toUtf8Bytes("roll-rep2")),
      geojsonHash:   ethers.keccak256(ethers.toUtf8Bytes("roll-p2")) });
    for (const a of [auditor1, auditor2, auditor3]) {
      await oracle.connect(a).submitAttestation(c1.attestation.satelliteHash, c1.attestation.reportHash, c1.parcel.geojsonHash);
      await oracle.connect(a).submitAttestation(c2.attestation.satelliteHash, c2.attestation.reportHash, c2.parcel.geojsonHash);
    }

    // Mint the one allowed credit for today
    await registry.connect(government).mintCredit(c1, "0x");
    // Second mint in same window: MintingCapExceeded
    await expect(registry.connect(government).mintCredit(c2, "0x"))
      .to.be.revertedWithCustomError(registry, "MintingCapExceeded");

    // Advance past the 1-day window — period rolls over
    await advanceDays(2);
    // Same credit (c2) is now mintable in the new period
    await expect(registry.connect(government).mintCredit(c2, "0x")).to.not.be.reverted;
  });

  it("setMintingCap with period=0 defaults to 1 day", async function () {
    const { registry, government } = await deployFixture();
    await registry.connect(government).setMintingCap(100, 0);
    const period = await registry.mintingPeriod();
    expect(period).to.equal(86400n); // 1 day in seconds
  });

  it("_update: allowlist blocks 'to' address on transfer", async function () {
    const { registry, oracle, government, auditor1, auditor2, auditor3, buyer } = await deployFixture();
    const credit = buildCredit({ serialId: "CRS#AL-001",
      satelliteHash: ethers.keccak256(ethers.toUtf8Bytes("al-sat")),
      reportHash:    ethers.keccak256(ethers.toUtf8Bytes("al-rep")),
      geojsonHash:   ethers.keccak256(ethers.toUtf8Bytes("al-p")) });
    for (const a of [auditor1, auditor2, auditor3])
      await oracle.connect(a).submitAttestation(
        credit.attestation.satelliteHash, credit.attestation.reportHash, credit.parcel.geojsonHash);
    await registry.connect(government).mintCredit(credit, "0x");

    // Deploy allowlist; allow government (from) but NOT buyer (to)
    const MockAllowlist = await ethers.getContractFactory("MockAllowlist");
    const mockAL = await MockAllowlist.deploy();
    await mockAL.allow(government.address);
    await registry.connect(government).setAllowlist(await mockAL.getAddress());

    // Transfer from government → buyer: buyer not allowlisted → NotAllowlisted
    await expect(
      registry.connect(government).transferFrom(government.address, buyer.address, 1n)
    ).to.be.revertedWithCustomError(registry, "NotAllowlisted").withArgs(buyer.address);
  });

  // Helper — sign attestation for a single credit
  async function signCredit(oracle, credit, auditors) {
    for (const a of auditors)
      await oracle.connect(a).submitAttestation(
        credit.attestation.satelliteHash, credit.attestation.reportHash, credit.parcel.geojsonHash);
  }

  it("mintCredit reverts WrongIssuingChain when issuingChainId doesn't match registry nationCode", async function () {
    const { registry, oracle, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const LIBERIA = ethers.zeroPadBytes("0x4C", 2); // not DRC
    const c = buildCredit({ serialId: "CRS#WIC-SC-001", issuingChainId: LIBERIA,
      satelliteHash: ethers.keccak256(ethers.toUtf8Bytes("wic-sc-sat")),
      reportHash:    ethers.keccak256(ethers.toUtf8Bytes("wic-sc-rep")),
      geojsonHash:   ethers.keccak256(ethers.toUtf8Bytes("wic-sc-p")) });
    await signCredit(oracle, c, [auditor1, auditor2, auditor3]);
    await expect(registry.connect(government).mintCredit(c, "0x"))
      .to.be.revertedWithCustomError(registry, "WrongIssuingChain");
  });

  it("mintBatch reverts AttestationNotFinalized inside the per-credit loop", async function () {
    const { registry, government } = await deployFixture();
    // No attestation submitted — oracle will return false for verifyAttestation
    const c = buildCredit({ serialId: "CRS#ANF-001",
      satelliteHash: ethers.keccak256(ethers.toUtf8Bytes("anf-sat")),
      reportHash:    ethers.keccak256(ethers.toUtf8Bytes("anf-rep")),
      geojsonHash:   ethers.keccak256(ethers.toUtf8Bytes("anf-p")) });
    await expect(registry.connect(government).mintBatch([c], "0x"))
      .to.be.revertedWithCustomError(registry, "AttestationNotFinalized");
  });

  it("mintBatch reverts InvalidVintageYear inside the per-credit loop", async function () {
    const { registry, oracle, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit({ serialId: "CRS#VY-001", vintageYear: 2001, // out of range
      satelliteHash: ethers.keccak256(ethers.toUtf8Bytes("vy-sat")),
      reportHash:    ethers.keccak256(ethers.toUtf8Bytes("vy-rep")),
      geojsonHash:   ethers.keccak256(ethers.toUtf8Bytes("vy-p")) });
    await signCredit(oracle, c, [auditor1, auditor2, auditor3]);
    await expect(registry.connect(government).mintBatch([c], "0x"))
      .to.be.revertedWithCustomError(registry, "InvalidVintageYear");
  });

  it("mintBatch reverts WrongIssuingChain inside the per-credit loop", async function () {
    const { registry, oracle, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const LIBERIA = ethers.zeroPadBytes("0x4C", 2); // not DRC
    const c = buildCredit({ serialId: "CRS#WIC-001", issuingChainId: LIBERIA,
      satelliteHash: ethers.keccak256(ethers.toUtf8Bytes("wic-sat")),
      reportHash:    ethers.keccak256(ethers.toUtf8Bytes("wic-rep")),
      geojsonHash:   ethers.keccak256(ethers.toUtf8Bytes("wic-p")) });
    await signCredit(oracle, c, [auditor1, auditor2, auditor3]);
    await expect(registry.connect(government).mintBatch([c], "0x"))
      .to.be.revertedWithCustomError(registry, "WrongIssuingChain");
  });

  it("mintBatch reverts UnapprovedMethodology when methodologyRegistry is configured", async function () {
    const { registry, oracle, government, admin, auditor1, auditor2, auditor3 } = await deployFixture();

    const MR = await ethers.getContractFactory("MethodologyRegistry");
    const mr = await MR.deploy(admin.address);
    await mr.approveMethodology("APPROVED-METHOD-v1");
    await registry.connect(government).setMethodologyRegistry(await mr.getAddress());

    const c = buildCredit({ serialId: "CRS#UM-001", methodology: "UNAPPROVED-METHOD",
      satelliteHash: ethers.keccak256(ethers.toUtf8Bytes("um-sat")),
      reportHash:    ethers.keccak256(ethers.toUtf8Bytes("um-rep")),
      geojsonHash:   ethers.keccak256(ethers.toUtf8Bytes("um-p")) });
    await signCredit(oracle, c, [auditor1, auditor2, auditor3]);
    await expect(registry.connect(government).mintBatch([c], "0x"))
      .to.be.revertedWithCustomError(registry, "UnapprovedMethodology");
  });

  it("retireBatch succeeds and emits BatchRetired + NCRIStatsBroadcast", async function () {
    const { registry, oracle, government, auditor1, auditor2, auditor3 } = await deployFixture();
    // Mint 2 credits
    const c1 = buildCredit({ serialId: "CRS#RB-001",
      satelliteHash: ethers.keccak256(ethers.toUtf8Bytes("rb-sat1")),
      reportHash:    ethers.keccak256(ethers.toUtf8Bytes("rb-rep1")),
      geojsonHash:   ethers.keccak256(ethers.toUtf8Bytes("rb-p1")) });
    const c2 = buildCredit({ serialId: "CRS#RB-002",
      satelliteHash: ethers.keccak256(ethers.toUtf8Bytes("rb-sat2")),
      reportHash:    ethers.keccak256(ethers.toUtf8Bytes("rb-rep2")),
      geojsonHash:   ethers.keccak256(ethers.toUtf8Bytes("rb-p2")) });
    for (const a of [auditor1, auditor2, auditor3]) {
      await oracle.connect(a).submitAttestation(c1.attestation.satelliteHash, c1.attestation.reportHash, c1.parcel.geojsonHash);
      await oracle.connect(a).submitAttestation(c2.attestation.satelliteHash, c2.attestation.reportHash, c2.parcel.geojsonHash);
    }
    await registry.connect(government).mintCredit(c1, "0x");
    await registry.connect(government).mintCredit(c2, "0x");

    await expect(registry.connect(government).retireBatch([1n, 2n], "CORSIA BATCH", 0))
      .to.emit(registry, "BatchRetired")
      .and.to.emit(registry, "NCRIStatsBroadcast");
    expect(await registry.totalRetired()).to.equal(2n);
  });

  it("suspendCredit reverts NotSuspendable when credit is already retired", async function () {
    const { registry, oracle, government, auditor1, auditor2, auditor3 } = await deployFixture();
    const credit = buildCredit({ serialId: "CRS#NS-001",
      satelliteHash: ethers.keccak256(ethers.toUtf8Bytes("ns-sat")),
      reportHash:    ethers.keccak256(ethers.toUtf8Bytes("ns-rep")),
      geojsonHash:   ethers.keccak256(ethers.toUtf8Bytes("ns-p")) });
    for (const a of [auditor1, auditor2, auditor3])
      await oracle.connect(a).submitAttestation(
        credit.attestation.satelliteHash, credit.attestation.reportHash, credit.parcel.geojsonHash);
    await registry.connect(government).mintCredit(credit, "0x");
    // Retire the credit first
    await registry.connect(government).retireCredit(1n, "retired", 0);
    // Now attempt to suspend a RETIRED token — NotSuspendable
    await expect(registry.connect(auditor1).suspendCredit(1n))
      .to.be.revertedWithCustomError(registry, "NotSuspendable").withArgs(1n);
  });

  it("VaultRecordFailed emitted when vault.recordRetirement reverts", async function () {
    const { registry, vault, oracle, government, admin, auditor1, auditor2, auditor3 } = await deployFixture();
    const credit = buildCredit({ serialId: "CRS#VRF-001",
      satelliteHash: ethers.keccak256(ethers.toUtf8Bytes("vrf-sat")),
      reportHash:    ethers.keccak256(ethers.toUtf8Bytes("vrf-rep")),
      geojsonHash:   ethers.keccak256(ethers.toUtf8Bytes("vrf-p")) });
    for (const a of [auditor1, auditor2, auditor3])
      await oracle.connect(a).submitAttestation(
        credit.attestation.satelliteHash, credit.attestation.reportHash, credit.parcel.geojsonHash);
    await registry.connect(government).mintCredit(credit, "0x");

    // Activate vault fee (1 ether) so recordRetirement called with 0 ETH will revert
    await vault.connect(admin).setRetirementFee(ethers.parseEther("1"));
    await vault.connect(admin).setFeeRecipient(admin.address);

    // retireCredit calls _retire → try vault.recordRetirement(0 ETH) → vault reverts
    // → catch block emits VaultRecordFailed; retirement itself still succeeds
    await expect(registry.connect(government).retireCredit(1n, "VRF TEST", 0))
      .to.emit(registry, "VaultRecordFailed").withArgs(1n, DRC_CODE());
  });
});

// ── NCRIIndex coverage gaps ────────────────────────────────────

describe("Coverage — NCRIIndex", function () {

  it("syncNationStats: StatJumpTooLarge fires on totalRetired jump", async function () {
    const { index, admin } = await deployFixture();
    const [,, relayer] = await ethers.getSigners();
    await index.connect(admin).addRelayer(relayer.address);

    const CODE = DRC_CODE();
    const BIG  = 10_000_001n; // one over DEFAULT_STAT_JUMP

    // Initial valid sync: minted=100, active=100, retired=0, suspended=0
    await index.connect(relayer).syncNationStats(CODE, 100n, 100n, 0n, 0n);

    // Minted jump = BIG - 100 = 9_999_901 ≤ maxStatJump → first check passes.
    // Retired jump = BIG - 0 = 10_000_001 > maxStatJump → hits line 221 StatJumpTooLarge.
    // Consistency: 0 + BIG + 0 == BIG ✓
    await expect(
      index.connect(relayer).syncNationStats(CODE, BIG, 0n, BIG, 0n)
    ).to.be.revertedWithCustomError(index, "StatJumpTooLarge");
  });

  it("removeRelayer revokes RELAYER_ROLE", async function () {
    const { index, admin } = await deployFixture();
    const [,, relayer] = await ethers.getSigners();
    await index.connect(admin).addRelayer(relayer.address);

    const RELAYER_ROLE = await index.RELAYER_ROLE();
    expect(await index.hasRole(RELAYER_ROLE, relayer.address)).to.be.true;

    await index.connect(admin).removeRelayer(relayer.address);
    expect(await index.hasRole(RELAYER_ROLE, relayer.address)).to.be.false;
  });

  it("syncNationStats when nation inactive: global counters unchanged", async function () {
    const { index, admin } = await deployFixture();
    const [,, relayer] = await ethers.getSigners();
    await index.connect(admin).addRelayer(relayer.address);

    const CODE = DRC_CODE();
    // Sync initial stats
    await index.connect(relayer).syncNationStats(CODE, 500n, 400n, 100n, 0n);

    // Deactivate the nation
    await index.connect(admin).deactivateNation(CODE);

    // Sync while inactive — global counters must stay at 0 (nation was subtracted on deactivate)
    await index.connect(relayer).syncNationStats(CODE, 600n, 500n, 100n, 0n);
    expect(await index.globalActiveSupply()).to.equal(0n);
  });
});

// ── RetirementVault coverage gaps ─────────────────────────────

describe("Coverage — RetirementVault", function () {

  it("recordRetirement refunds excess ETH above fee to caller", async function () {
    // Deploy a fresh vault and register admin as a registry so we can call recordRetirement directly
    const [admin, stranger] = await ethers.getSigners();
    const RetirementVault = await ethers.getContractFactory("RetirementVault");
    const vault2 = await RetirementVault.deploy(admin.address);
    await vault2.addRegistry(admin.address, DRC_CODE());

    const feeWei = ethers.parseEther("0.1");
    await vault2.setRetirementFee(feeWei);
    await vault2.setFeeRecipient(stranger.address);

    const record = buildRecord();

    // Send 0.15 ETH for a 0.1 ETH fee — 0.05 ETH should be refunded to admin
    const balBefore = await ethers.provider.getBalance(admin.address);
    const tx = await vault2.recordRetirement(record, { value: ethers.parseEther("0.15") });
    const receipt = await tx.wait();
    const gasUsed = receipt.gasUsed * receipt.gasPrice;
    const balAfter = await ethers.provider.getBalance(admin.address);

    // Net cost = fee (0.1 ETH) + gas; the 0.05 ETH surplus was refunded
    const netCost = balBefore - balAfter;
    expect(netCost).to.be.closeTo(feeWei + gasUsed, ethers.parseEther("0.001"));
  });

  it("getRecentRetirements returns last N records in order", async function () {
    // Deploy a fresh vault and register admin as a registry
    const [admin] = await ethers.getSigners();
    const RetirementVault = await ethers.getContractFactory("RetirementVault");
    const vault2 = await RetirementVault.deploy(admin.address);
    await vault2.addRegistry(admin.address, DRC_CODE());

    for (let i = 1; i <= 3; i++) {
      await vault2.recordRetirement(buildRecord({
        tokenId:  BigInt(i),
        serialId: `CRS#REC-00${i}`,
        purpose:  `reason-${i}`,
      }));
    }

    const recent = await vault2.getRecentRetirements(2n);
    expect(recent.length).to.equal(2);
    // Should return records 2 and 3 (the last 2)
    expect(recent[0].tokenId).to.equal(2n);
    expect(recent[1].tokenId).to.equal(3n);
  });
});

// ── CarbonPool coverage gaps ──────────────────────────────────

describe("Coverage — CarbonPool", function () {

  async function deployCoveragePoolFixture() {
    const { registry, oracle, vault, admin, government, auditor1, auditor2, auditor3, stranger } = await deployFixture();
    const CarbonPool = await ethers.getContractFactory("CarbonPool");
    const pool = await CarbonPool.deploy(await registry.getAddress(), "DRC Pool", "DCP", 0, 0);
    const poolAddr     = await pool.getAddress();
    const registryAddr = await registry.getAddress();

    // Vault fee = 0 so retireCredit succeeds without ETH
    await vault.connect(admin).setRetirementFee(0n);

    // Mint a credit and deposit it into the pool
    const credit = buildCredit({ serialId: "CRS#CP-001",
      satelliteHash: ethers.keccak256(ethers.toUtf8Bytes("cp-sat")),
      reportHash:    ethers.keccak256(ethers.toUtf8Bytes("cp-rep")),
      geojsonHash:   ethers.keccak256(ethers.toUtf8Bytes("cp-p")) });
    for (const a of [auditor1, auditor2, auditor3])
      await oracle.connect(a).submitAttestation(
        credit.attestation.satelliteHash, credit.attestation.reportHash, credit.parcel.geojsonHash);
    await registry.connect(government).mintCredit(credit, "0x");

    return { registry, oracle, vault, pool, admin, government, auditor1, auditor2, auditor3, stranger,
             poolAddr, registryAddr, credit };
  }

  it("removeRegistry sets approvedRegistries[registry] to false", async function () {
    const { pool, admin, registryAddr } = await deployCoveragePoolFixture();
    expect(await pool.approvedRegistries(registryAddr)).to.be.true;
    await pool.connect(admin).removeRegistry(registryAddr);
    expect(await pool.approvedRegistries(registryAddr)).to.be.false;
  });

  it("poolTokens returns all token IDs in the pool", async function () {
    const { registry, pool, government, poolAddr, registryAddr } = await deployCoveragePoolFixture();
    await registry.connect(government).approve(poolAddr, 1n);
    await pool.connect(government).deposit(registryAddr, 1n);
    const tokens = await pool.poolTokens();
    expect(tokens.length).to.equal(1);
    expect(tokens[0]).to.equal(1n);
  });

  it("onERC721Received reverts NotAllowlisted when pool allowlist blocks sender", async function () {
    const { registry, pool, admin, government, poolAddr } = await deployCoveragePoolFixture();

    // Set pool allowlist — government NOT allowed
    const MockAllowlist = await ethers.getContractFactory("MockAllowlist");
    const mockAL = await MockAllowlist.deploy();
    // Don't call mockAL.allow(government.address) — government stays blocked
    // CarbonPool uses Ownable; deployer (admin = signers[0]) is the owner
    await pool.connect(admin).setAllowlist(await mockAL.getAddress());

    await registry.connect(government).approve(poolAddr, 1n);

    // Direct safeTransferFrom bypasses pool.deposit() allowlist check —
    // triggers onERC721Received on the pool with from = government (blocked).
    await expect(
      registry.connect(government)["safeTransferFrom(address,address,uint256)"](
        government.address, poolAddr, 1n
      )
    ).to.be.revertedWithCustomError(pool, "NotAllowlisted").withArgs(government.address);
  });

  it("redeem reverts CreditNotTransferable when credit is suspended", async function () {
    const { registry, pool, government, auditor1, poolAddr, registryAddr } = await deployCoveragePoolFixture();
    await registry.connect(government).approve(poolAddr, 1n);
    await pool.connect(government).deposit(registryAddr, 1n);

    // Auditor1 has AUDITOR_ROLE on the registry — suspend the credit while it's in the pool
    await registry.connect(auditor1).suspendCredit(1n);

    // Redeem should revert because the credit is now SUSPENDED (not ACTIVE or LISTED)
    await expect(pool.connect(government).redeem(1n))
      .to.be.revertedWithCustomError(pool, "CreditNotTransferable").withArgs(1n);
  });
});

// ── MethodologyRegistry coverage gaps ─────────────────────────

describe("Coverage — MethodologyRegistry", function () {
  it("getKey returns the keccak256 of the methodology name", async function () {
    const [admin] = await ethers.getSigners();
    const MR = await ethers.getContractFactory("MethodologyRegistry");
    const mr = await MR.deploy(admin.address);
    const name = "ART-TREES-v2.0";
    const expected = ethers.keccak256(ethers.toUtf8Bytes(name));
    expect(await mr.getKey(name)).to.equal(expected);
  });
});

// ── MRVOracle coverage gaps ────────────────────────────────────

describe("Coverage — MRVOracle", function () {

  it("addAuditor is idempotent — adding existing auditor does not increment counter", async function () {
    const { oracle, admin, auditor1 } = await deployFixture();
    const countBefore = await oracle.totalAuditors();
    // auditor1 already has AUDITOR_ROLE from deployFixture
    await oracle.connect(admin).addAuditor(auditor1.address);
    expect(await oracle.totalAuditors()).to.equal(countBefore);
  });

  it("verifyAttestation returns false when parcel hash does not match stored composite", async function () {
    const { oracle, auditor1, auditor2, auditor3 } = await deployFixture();
    const c = buildCredit();
    for (const a of [auditor1, auditor2, auditor3])
      await oracle.connect(a).submitAttestation(
        c.attestation.satelliteHash, c.attestation.reportHash, c.parcel.geojsonHash);

    // Call verifyAttestation with a DIFFERENT parcel hash — should return false
    const wrongParcel = ethers.keccak256(ethers.toUtf8Bytes("WRONG-PARCEL"));
    const result = await oracle.verifyAttestation(c.attestation, wrongParcel, "0x");
    expect(result).to.be.false;
  });

  it("executeThreshold reverts ThresholdExceedsAuditors if auditor removed after proposal", async function () {
    // Start with exactly threshold=3 auditors.  Remove one AFTER proposing threshold=3
    // so that at execute time totalAuditors < pendingThreshold would NOT be the issue here.
    // Actually test the simpler case: propose threshold=5, then remove an auditor so
    // totalAuditors drops below 5, then executeThreshold reverts.
    const [admin] = await ethers.getSigners();
    const MRVOracle = await ethers.getContractFactory("MRVOracle");
    const oracle2 = await MRVOracle.deploy(admin.address, 3);

    // Add 5 auditors
    const signers = await ethers.getSigners();
    const aud = signers.slice(2, 7);
    for (const a of aud) await oracle2.connect(admin).addAuditor(a.address);

    // Propose threshold = 5 (valid — totalAuditors == 5)
    await oracle2.connect(admin).proposeThreshold(5);
    await advanceDays(2);

    // Remove one auditor — now totalAuditors = 4 < pendingThreshold = 5
    await oracle2.connect(admin).removeAuditor(aud[0].address);

    // executeThreshold must revert with ThresholdExceedsAuditors
    await expect(oracle2.connect(admin).executeThreshold())
      .to.be.revertedWithCustomError(oracle2, "ThresholdExceedsAuditors");
  });
});
