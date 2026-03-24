// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";

/// @title NCRI Index — Natural Carbon Reserve Index
/// @notice Lives on the NCRI Hub chain. Aggregates all sovereign national
///         registries into a single global index. This is the product that
///         makes CCR a platform, not just a single-country project.
///         Institutional funds can buy a basket of CRS tokens weighted by
///         this index — the same way a fund buys the S&P 500.
contract NCRIIndex is AccessControl {

    // ─────────────────────────────────────────────────────
    //  ERRORS
    // ─────────────────────────────────────────────────────

    error InvalidAdmin();
    error InvalidNationCode();
    error InvalidRegistry();
    error InvalidRelayer();
    /// @param nationCode The code that already exists
    error NationAlreadyExists(bytes2 nationCode);
    /// @param nationCode The code that was not found
    error NationNotFound(bytes2 nationCode);
    /// @param nationCode The nation that is already inactive
    error AlreadyInactive(bytes2 nationCode);
    /// @param nationCode The nation that is already active
    error AlreadyActive(bytes2 nationCode);
    /// @param current  Value currently stored
    /// @param provided Value the relayer attempted to set
    error MintedMustNotDecrease(uint256 current, uint256 provided);
    /// @param current  Value currently stored
    /// @param provided Value the relayer attempted to set
    error RetiredMustNotDecrease(uint256 current, uint256 provided);
    /// @param active  Supplied totalActive value
    /// @param minted  Supplied totalMinted value
    error ActiveExceedsMinted(uint256 active, uint256 minted);
    /// @param current  Value currently stored
    /// @param provided Value the relayer attempted to set
    /// @param maxJump  Maximum single-update increase allowed
    error StatJumpTooLarge(uint256 current, uint256 provided, uint256 maxJump);
    error InvalidStatJump();
    /// @param active    Supplied totalActive value
    /// @param retired   Supplied totalRetired value
    /// @param suspended Supplied totalSuspended value
    /// @param minted    Supplied totalMinted value
    error StatsInconsistent(uint256 active, uint256 retired, uint256 suspended, uint256 minted);

    // ─────────────────────────────────────────────────────
    //  ROLES
    // ─────────────────────────────────────────────────────

    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    bytes32 public constant RELAYER_ROLE    = keccak256("RELAYER_ROLE");
    bytes32 public constant ADMIN_ROLE      = keccak256("ADMIN_ROLE");

    /// @notice Default cap on the increase in totalMinted or totalRetired allowed per sync.
    uint256 public constant DEFAULT_STAT_JUMP = 10_000_000;

    /// @notice Governable cap. GOVERNANCE_ROLE can raise this before onboarding a large
    ///         nation whose initial sync would exceed the default limit.
    ///         Prevents a compromised relayer from injecting astronomically wrong values.
    uint256 public maxStatJump = DEFAULT_STAT_JUMP;

    // ─────────────────────────────────────────────────────
    //  NATION SLOT
    // ─────────────────────────────────────────────────────

    struct NationSlot {
        bytes2  nationCode;
        string  nationName;
        address registryAddress;
        string  ibcChannelId;
        uint256 totalMinted;
        uint256 totalActive;
        uint256 totalRetired;
        uint256 totalSuspended;
        uint64  joinedAt;
        bool    isActive;
    }

    // ─────────────────────────────────────────────────────
    //  STORAGE
    // ─────────────────────────────────────────────────────

    NationSlot[]               public nations;
    mapping(bytes2 => uint256) public nationIndex;  // 1-based; 0 means not registered

    uint256 public globalActiveSupply;
    uint256 public globalRetiredSupply;
    uint256 public globalMintedSupply;

    // ─────────────────────────────────────────────────────
    //  EVENTS
    // ─────────────────────────────────────────────────────

    event NationAdded(bytes2 indexed nationCode, string nationName, address registryAddress);
    event NationDeactivated(bytes2 indexed nationCode);
    event NationReactivated(bytes2 indexed nationCode);
    event NationStatsUpdated(bytes2 indexed nationCode, uint256 totalActive, uint256 totalRetired);
    event MaxStatJumpUpdated(uint256 oldMax, uint256 newMax);

    // ─────────────────────────────────────────────────────
    //  CONSTRUCTOR
    // ─────────────────────────────────────────────────────

    constructor(address admin) {
        if (admin == address(0)) revert InvalidAdmin();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
        _grantRole(GOVERNANCE_ROLE, admin);
    }

    // ─────────────────────────────────────────────────────
    //  NATION MANAGEMENT
    // ─────────────────────────────────────────────────────

    /// @notice Register a new sovereign nation in the NCRI index.
    /// @param  _nationCode      ISO 3166-1 alpha-2 code (e.g. bytes2("CD") for DRC).
    /// @param  _nationName      Human-readable nation name.
    /// @param  _registryAddress Address of the nation's SovereignRegistry contract.
    /// @param  _ibcChannelId    IBC channel identifier for cross-chain stat relaying.
    function addNation(
        bytes2  _nationCode,
        string  calldata _nationName,
        address _registryAddress,
        string  calldata _ibcChannelId
    ) external onlyRole(GOVERNANCE_ROLE) {
        if (_nationCode      == bytes2(0))  revert InvalidNationCode();
        if (_registryAddress == address(0)) revert InvalidRegistry();
        if (nationIndex[_nationCode] > 0)   revert NationAlreadyExists(_nationCode);

        nations.push(NationSlot({
            nationCode:      _nationCode,
            nationName:      _nationName,
            registryAddress: _registryAddress,
            ibcChannelId:    _ibcChannelId,
            totalMinted:     0,
            totalActive:     0,
            totalRetired:    0,
            totalSuspended:  0,
            joinedAt:        uint64(block.timestamp),
            isActive:        true
        }));

        nationIndex[_nationCode] = nations.length; // 1-based

        emit NationAdded(_nationCode, _nationName, _registryAddress);
    }

    /// @notice Deactivate a nation (e.g. if a government partnership ends).
    ///         Subtracts its active supply from global aggregates so index weights
    ///         remain accurate while the nation is paused.
    /// @param  _nationCode Nation to deactivate.
    function deactivateNation(bytes2 _nationCode) external onlyRole(GOVERNANCE_ROLE) {
        if (nationIndex[_nationCode] == 0) revert NationNotFound(_nationCode);
        NationSlot storage n = nations[nationIndex[_nationCode] - 1];
        if (!n.isActive) revert AlreadyInactive(_nationCode);

        globalActiveSupply  -= n.totalActive;
        globalRetiredSupply -= n.totalRetired;
        globalMintedSupply  -= n.totalMinted;

        n.isActive = false;
        emit NationDeactivated(_nationCode);
    }

    /// @notice Reactivate a previously deactivated nation.
    ///         Re-adds its last-known supply to the global aggregates.
    /// @param  _nationCode Nation to reactivate.
    function reactivateNation(bytes2 _nationCode) external onlyRole(GOVERNANCE_ROLE) {
        if (nationIndex[_nationCode] == 0) revert NationNotFound(_nationCode);
        NationSlot storage n = nations[nationIndex[_nationCode] - 1];
        if (n.isActive) revert AlreadyActive(_nationCode);

        globalActiveSupply  += n.totalActive;
        globalRetiredSupply += n.totalRetired;
        globalMintedSupply  += n.totalMinted;

        n.isActive = true;
        emit NationReactivated(_nationCode);
    }

    // ─────────────────────────────────────────────────────
    //  STATS SYNC — called by IBC relayer
    // ─────────────────────────────────────────────────────

    /// @notice Update a nation's stats. Called by the IBC relayer after consuming
    ///         an NCRIStatsBroadcast event from the national SovereignRegistry.
    /// @dev    Monotonicity invariants prevent a buggy or compromised relayer from
    ///         causing underflow on the global aggregate counters.
    /// @param  _nationCode    Nation to update.
    /// @param  _totalMinted   New total minted — must be >= current value.
    /// @param  _totalActive   New total active — must be <= _totalMinted.
    /// @param  _totalRetired  New total retired — must be >= current value.
    /// @param  _totalSuspended New total suspended.
    function syncNationStats(
        bytes2  _nationCode,
        uint256 _totalMinted,
        uint256 _totalActive,
        uint256 _totalRetired,
        uint256 _totalSuspended
    ) external onlyRole(RELAYER_ROLE) {
        if (nationIndex[_nationCode] == 0) revert NationNotFound(_nationCode);

        NationSlot storage n = nations[nationIndex[_nationCode] - 1];

        if (_totalMinted  < n.totalMinted)  revert MintedMustNotDecrease(n.totalMinted,  _totalMinted);
        if (_totalRetired < n.totalRetired) revert RetiredMustNotDecrease(n.totalRetired, _totalRetired);
        if (_totalActive  > _totalMinted)   revert ActiveExceedsMinted(_totalActive,       _totalMinted);
        // Enforce the ledger identity: active + retired + suspended == minted.
        // SovereignRegistry always emits NCRIStatsBroadcast with totalActive = totalMinted -
        // totalRetired - totalSuspended, so this must hold for any honestly relayed data.
        // Rejects a buggy or compromised relayer submitting internally inconsistent stats.
        if (_totalActive + _totalRetired + _totalSuspended != _totalMinted)
            revert StatsInconsistent(_totalActive, _totalRetired, _totalSuspended, _totalMinted);
        if (_totalMinted  - n.totalMinted  > maxStatJump)
            revert StatJumpTooLarge(n.totalMinted,  _totalMinted,  maxStatJump);
        if (_totalRetired - n.totalRetired > maxStatJump)
            revert StatJumpTooLarge(n.totalRetired, _totalRetired, maxStatJump);

        if (n.isActive) {
            globalActiveSupply  = globalActiveSupply  - n.totalActive  + _totalActive;
            globalRetiredSupply = globalRetiredSupply - n.totalRetired + _totalRetired;
            globalMintedSupply  = globalMintedSupply  - n.totalMinted  + _totalMinted;
        }

        n.totalMinted    = _totalMinted;
        n.totalActive    = _totalActive;
        n.totalRetired   = _totalRetired;
        n.totalSuspended = _totalSuspended;

        emit NationStatsUpdated(_nationCode, _totalActive, _totalRetired);
    }

    // ─────────────────────────────────────────────────────
    //  INDEX COMPOSITION
    // ─────────────────────────────────────────────────────

    /// @notice Calculate each nation's weight in the index (basis points, 10 000 = 100%).
    ///         Integer-division dust is allocated to the largest active nation,
    ///         guaranteeing weights always sum to exactly 10 000 when supply > 0.
    /// @return codes   Array of nation codes; inactive nations included with weight 0.
    /// @return weights Array of weights in basis points; sum == 10 000 iff supply > 0.
    function rebalance()
        external view
        returns (bytes2[] memory codes, uint256[] memory weights)
    {
        uint256 count = nations.length;
        codes   = new bytes2[](count);
        weights = new uint256[](count);

        // Always populate codes — callers enumerate all nations regardless of supply
        unchecked {
            for (uint256 i = 0; i < count; i++) {
                codes[i] = nations[i].nationCode;
            }
        }

        if (globalActiveSupply == 0) return (codes, weights);

        uint256 largestActive = 0;
        uint256 largestIdx    = 0;
        uint256 totalWeight   = 0;

        unchecked {
            for (uint256 i = 0; i < count; i++) {
                if (nations[i].isActive) {
                    uint256 w     = (nations[i].totalActive * 10_000) / globalActiveSupply;
                    weights[i]    = w;
                    totalWeight  += w;
                    if (nations[i].totalActive > largestActive) {
                        largestActive = nations[i].totalActive;
                        largestIdx    = i;
                    }
                }
            }
        }

        // Allocate integer-division dust to the largest active nation
        if (largestActive > 0) {
            weights[largestIdx] += 10_000 - totalWeight;
        }
    }

    // ─────────────────────────────────────────────────────
    //  VIEWS
    // ─────────────────────────────────────────────────────

    /// @notice Total number of registered nations (active and inactive).
    function nationCount() external view returns (uint256) {
        return nations.length;
    }

    /// @notice Fetch the full NationSlot for a given nation code.
    function getNation(bytes2 _nationCode) external view returns (NationSlot memory) {
        if (nationIndex[_nationCode] == 0) revert NationNotFound(_nationCode);
        return nations[nationIndex[_nationCode] - 1];
    }

    // ─────────────────────────────────────────────────────
    //  RELAYER MANAGEMENT
    // ─────────────────────────────────────────────────────

    /// @notice Update the per-sync stat jump cap. Raise before onboarding a large nation
    ///         whose initial batch would legitimately exceed the current limit.
    /// @param  newMax New maximum increase per sync call; must be > 0.
    function setMaxStatJump(uint256 newMax) external onlyRole(GOVERNANCE_ROLE) {
        if (newMax == 0) revert InvalidStatJump();
        uint256 old = maxStatJump;
        maxStatJump = newMax;
        emit MaxStatJumpUpdated(old, newMax);
    }

    /// @notice Grant RELAYER_ROLE to an IBC relayer address.
    function addRelayer(address relayer) external onlyRole(ADMIN_ROLE) {
        if (relayer == address(0)) revert InvalidRelayer();
        _grantRole(RELAYER_ROLE, relayer);
    }

    /// @notice Revoke RELAYER_ROLE from an IBC relayer address.
    function removeRelayer(address relayer) external onlyRole(ADMIN_ROLE) {
        _revokeRole(RELAYER_ROLE, relayer);
    }
}
