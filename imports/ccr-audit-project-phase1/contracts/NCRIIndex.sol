// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";

/// @title NCRIIndex
/// @notice National Carbon Registry Index - tracks carbon credit supply and weights by nation
/// @dev Maintains nation registries with active supply and provides rebalancing functionality
contract NCRIIndex is AccessControl {
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");

    struct Nation {
        bytes2 code;
        string name;
        uint256 activeSupply;
        bool isActive;
    }

    mapping(bytes2 => Nation) public nations;
    bytes2[] public nationCodes;
    uint256 public nationCount;
    uint256 public globalActiveSupply;

    /// @notice Emitted when a new nation is registered
    event NationAdded(bytes2 indexed code, string name);
    
    /// @notice Emitted when a nation supply is deactivated
    event NationDeactivated(bytes2 indexed code);
    
    /// @notice Emitted when a nation supply is reactivated
    event NationReactivated(bytes2 indexed code);
    
    /// @notice Emitted when supply weights are rebalanced
    event Rebalanced(uint256[] weights);

    /// @notice Initialize the index with an admin address
    /// @param admin Address to receive DEFAULT_ADMIN_ROLE
    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Register a new nation in the index
    /// @param code Two-byte nation code (must not be zero)
    /// @param name Nation name string
    function addNation(bytes2 code, string calldata name) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(code != bytes2(0), "INVALID_NATION_CODE");
        require(bytes(name).length > 0, "INVALID_NATION_NAME");
        require(nations[code].code == bytes2(0), "NATION_EXISTS");

        nations[code] = Nation(code, name, 0, true);
        nationCodes.push(code);
        nationCount++;

        emit NationAdded(code, name);
    }

    /// @notice Update active carbon credit supply for a nation
    /// @param code The nation code
    /// @param activeSupply New active supply amount
    function syncNationStats(bytes2 code, uint256 activeSupply) external onlyRole(RELAYER_ROLE) {
        require(nations[code].isActive, "NATION_INACTIVE");
        Nation storage n = nations[code];
        globalActiveSupply = globalActiveSupply - n.activeSupply + activeSupply;
        n.activeSupply = activeSupply;
    }

    /// @notice Deactivate a nation (e.g., for non-compliance)
    /// @param code The nation code to deactivate
    function deactivateNation(bytes2 code) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Nation storage n = nations[code];
        require(n.isActive, "ALREADY_INACTIVE");
        n.isActive = false;
        globalActiveSupply -= n.activeSupply;
        emit NationDeactivated(code);
    }

    /// @notice Reactivate a deactivated nation
    /// @param code The nation code to reactivate
    function reactivateNation(bytes2 code) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Nation storage n = nations[code];
        require(!n.isActive, "ALREADY_ACTIVE");
        n.isActive = true;
        globalActiveSupply += n.activeSupply;
        emit NationReactivated(code);
    }

    /// @notice Calculate rebalanced supply weights across all active nations
    /// @dev Uses first-by-size allocation method for rounding dust
    /// @return weights Array of basis points (summing to exactly 10000) for each nation
    function rebalance() external view returns (uint256[] memory weights) {
        weights = new uint256[](nationCount);
        uint256 totalBasis = 10000;
        uint256 remaining = totalBasis;
        uint256 largestIdx = 0;
        uint256 largestWeight = 0;

        for (uint256 i = 0; i < nationCount; i++) {
            bytes2 code = nationCodes[i];
            if (!nations[code].isActive) continue;
            uint256 supply = nations[code].activeSupply;
            uint256 weight = (supply * totalBasis) / globalActiveSupply;
            weights[i] = weight;
            if (weight > largestWeight) {
                largestWeight = weight;
                largestIdx = i;
            }
            remaining -= weight;
        }
        // Assign remaining dust to largest nation
        if (remaining > 0) {
            weights[largestIdx] += remaining;
        }
    }
}