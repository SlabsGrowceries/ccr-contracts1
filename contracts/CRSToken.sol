// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @title CRS Token — Congo Carbon Reserve Sovereign Carbon Credit
/// @notice Defines all data types used across the CCR contract system.
///         One CRS token = one verified tonne of CO₂ sequestered.

// ─────────────────────────────────────────────────────────
//  ENUMS
// ─────────────────────────────────────────────────────────

/// @notice The lifecycle state of a carbon credit token
enum TokenStatus {
    ACTIVE,     // 0 — Minted and verified — tradeable
    LISTED,     // 1 — Listed on NCRI marketplace
    RETIRED,    // 2 — Permanently burned — offset claimed
    SUSPENDED   // 3 — Flagged by auditor — under review
}

/// @notice The compliance framework under which a credit was retired
enum CompliancePurpose {
    VOLUNTARY,      // 0 — Voluntary carbon market
    CORSIA,         // 1 — ICAO CORSIA aviation offset scheme
    ARTICLE_6_2,    // 2 — Paris Agreement bilateral transfer (ITMOs)
    NDC,            // 3 — Nationally Determined Contribution
    EU_ETS,         // 4 — EU Emissions Trading System
    UK_ETS,         // 5 — UK Emissions Trading System
    OTHER           // 6 — Other / custom compliance framework
}

/// @notice The type of carbon project that generated this credit
enum ProjectType {
    FOREST_PROTECTION,   // Avoided deforestation (REDD+)
    PEATLAND,            // Peatland conservation
    AFFORESTATION,       // New forest planting
    BLUE_CARBON,         // Mangrove / coastal wetland
    AGROFORESTRY,        // Integrated agriculture-forest systems
    IMPROVED_COOKSTOVE,  // Emissions avoidance
    BIOCHAR,             // Biochar soil sequestration
    RENEWABLE_ENERGY     // Clean energy emissions avoidance
}

// ─────────────────────────────────────────────────────────
//  STRUCTS
// ─────────────────────────────────────────────────────────

/// @notice GPS boundary data for the protected forest parcel
struct GeoParcel {
    bytes32  geojsonHash;    // keccak256 of the GeoJSON polygon (stored off-chain)
    int64    centroidLat;    // latitude × 1e8 to avoid floating point (e.g. -4.32° = -432000000)
    int64    centroidLon;    // longitude × 1e8
    uint32   areaHectares;   // size of the protected parcel in hectares
}

/// @notice The cryptographic proof that 3-of-5 auditors verified this credit.
///         Signer data is authoritative in MRVOracle — query oracle.attestations(id)
///         or oracle.sigCount(id) for verified on-chain signer information.
struct MRVAttestation {
    bytes32 satelliteHash;    // keccak256 of the satellite imagery file
    bytes32 reportHash;       // keccak256 of the auditor verification report PDF
    uint64  observationDate;  // unix timestamp of the satellite pass
    uint64  attestationDate;  // unix timestamp when oracle threshold was reached
}

/// @notice The full on-chain data stored for every CRS carbon credit token
struct CarbonCredit {
    // ── Identity ──
    string         serialId;          // e.g. "CRS#DRC-2031-000001" — unique forever
    bytes2         issuingChainId;    // Opaque 2-byte nation identifier; by convention the
                                       // big-endian ASCII bytes of the ISO 3166-1 alpha-2 code
                                       // (bytes2("CD") == 0x4344 for DRC; bytes2("LR") for Liberia)
    bytes32        projectId;         // unique project identifier

    // ── Classification ──
    ProjectType    projectType;
    string         methodology;       // e.g. "ART-TREES-v2.0", "VM0015"

    // ── Carbon Data ──
    uint64         tonneCO2e;         // carbon amount in kg (1 tonne = 1_000); convention
                                       // is 1_000 per credit but fractional credits are valid
    uint16         vintageYear;       // year the carbon was sequestered
    uint64         monitoringStart;   // monitoring period start (unix timestamp)
    uint64         monitoringEnd;     // monitoring period end (unix timestamp)

    // ── Geospatial ──
    GeoParcel      parcel;

    // ── Verification ──
    MRVAttestation attestation;

    // ── State ──
    TokenStatus    status;
    uint64         mintedAt;          // block timestamp when minted
    uint64         retiredAt;         // 0 until burned
    address        retiredBy;         // zero address until burned
    string         retirementReason;  // e.g. "CORSIA Q3 2032" or "Art6.2 NO-CD-2031"
}
