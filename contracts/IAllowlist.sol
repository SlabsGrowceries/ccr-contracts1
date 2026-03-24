// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @title IAllowlist — Pluggable KYC / AML / Sanctions Gate
/// @notice Any contract implementing this interface can serve as the
///         identity-verification and sanctions-screening layer for
///         SovereignRegistry and CarbonPool.
///
///         Compliant deployments should plug in one of:
///           • A managed whitelist contract (admin-curated KYC-verified addresses)
///           • A Chainalysis on-chain oracle (real-time OFAC / EU sanctions feed)
///           • An NFT-gated credential (Worldcoin proof-of-personhood)
///           • A jurisdiction-specific compliance module (MAS, FCA, BaFin)
///
///         Set the allowlist address to address(0) to disable screening
///         (permissionless / test mode). Governments deploying for compliance
///         MUST configure a non-zero allowlist before opening the registry
///         to external counterparties.
///
///         FATF Travel Rule integration note: for transfers above threshold,
///         this interface can be extended by the implementation to include
///         originator/beneficiary VASP information. The minimal isAllowed()
///         check handles the sanctions screening layer; Travel Rule data
///         exchange sits above this interface.
interface IAllowlist {

    /// @notice Returns true if `account` is permitted to participate in
    ///         the registry or pool (KYC verified, not sanctioned, not blocked).
    /// @param  account Address to screen — typically msg.sender or a transfer recipient.
    /// @return True if the address passes all compliance checks.
    function isAllowed(address account) external view returns (bool);
}
