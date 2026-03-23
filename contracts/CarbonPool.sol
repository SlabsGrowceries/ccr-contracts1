// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "./CRSToken.sol";
import "./SovereignRegistry.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/// @title Carbon Pool — ERC20 Fungible Wrapper for CRS Carbon Credits
/// @notice Wraps CRS ERC721 tokens into fungible ERC20 pool tokens, enabling
///         DeFi composability: pool tokens can be traded on AMMs, used as
///         collateral, or redeemed back for individual CRS credits on demand.
///
///         Deposit paths:
///           A) registry.approve(pool, tokenId) → pool.deposit(tokenId)
///           B) registry.safeTransferFrom(user, pool, tokenId) (triggers onERC721Received)
///
///         Redeem path:
///           pool.redeem(tokenId) — burns TOKENS_PER_CREDIT ERC20, returns specific ERC721
///
///         Optional vintage filter: set vintageFrom / vintageTo to restrict which
///         credits are eligible (e.g. a "Post-2025 Vintage" pool product).
///         Zero means no filter applied on that bound.
contract CarbonPool is ERC20, IERC721Receiver {

    // ─────────────────────────────────────────────────────
    //  ERRORS
    // ─────────────────────────────────────────────────────

    error InvalidRegistry();
    /// @param tokenId Token that is already in the pool
    error AlreadyInPool(uint256 tokenId);
    /// @param tokenId Token that is not eligible (wrong status)
    error NotEligible(uint256 tokenId);
    /// @param year    Vintage year of the credit
    /// @param minimum Pool's lower vintage bound
    error VintageTooOld(uint16 year, uint16 minimum);
    /// @param year    Vintage year of the credit
    /// @param maximum Pool's upper vintage bound
    error VintageTooNew(uint16 year, uint16 maximum);
    /// @param caller Address that called onERC721Received — must equal registry
    error WrongRegistry(address caller);
    /// @param tokenId Token that is not currently in the pool
    error NotInPool(uint256 tokenId);
    /// @param tokenId Token whose status prevents transfer (retired or suspended)
    error CreditNotTransferable(uint256 tokenId);

    // ─────────────────────────────────────────────────────
    //  STATE
    // ─────────────────────────────────────────────────────

    SovereignRegistry public immutable registry;

    /// @notice Vintage year lower bound — 0 = no lower limit
    uint16 public immutable vintageFrom;
    /// @notice Vintage year upper bound — 0 = no upper limit
    uint16 public immutable vintageTo;

    /// @notice 1 CRS ERC721 credit = TOKENS_PER_CREDIT pool ERC20 tokens
    uint256 public constant TOKENS_PER_CREDIT = 1e18;

    /// @dev Token IDs currently held in the pool (append-on-deposit, swap-pop-on-redeem)
    uint256[] private _queue;

    /// @dev 1-based position of tokenId in _queue; 0 means not in pool
    mapping(uint256 => uint256) private _queueIndex;

    // ─────────────────────────────────────────────────────
    //  EVENTS
    // ─────────────────────────────────────────────────────

    event CreditDeposited(uint256 indexed tokenId, address indexed depositor);
    event CreditRedeemed(uint256 indexed tokenId, address indexed redeemer);

    // ─────────────────────────────────────────────────────
    //  CONSTRUCTOR
    // ─────────────────────────────────────────────────────

    /// @param _registry    Address of the SovereignRegistry whose credits this pool accepts.
    /// @param name         ERC20 token name (e.g. "CCR Carbon Pool Token").
    /// @param symbol       ERC20 token symbol (e.g. "CCRP").
    /// @param _vintageFrom Minimum vintage year accepted; 0 = no lower bound.
    /// @param _vintageTo   Maximum vintage year accepted; 0 = no upper bound.
    constructor(
        address _registry,
        string memory name,
        string memory symbol,
        uint16 _vintageFrom,
        uint16 _vintageTo
    ) ERC20(name, symbol) {
        if (_registry == address(0)) revert InvalidRegistry();
        registry    = SovereignRegistry(_registry);
        vintageFrom = _vintageFrom;
        vintageTo   = _vintageTo;
    }

    // ─────────────────────────────────────────────────────
    //  DEPOSIT
    // ─────────────────────────────────────────────────────

    /// @notice Deposit a CRS credit into the pool and receive TOKENS_PER_CREDIT ERC20 tokens.
    /// @dev    Caller must first call registry.approve(address(this), tokenId).
    ///         Follows CEI: all state changes before the external transferFrom call.
    /// @param  tokenId Token ID of the CRS credit to deposit.
    function deposit(uint256 tokenId) external {
        // Checks
        _validateCredit(tokenId);
        if (_queueIndex[tokenId] != 0) revert AlreadyInPool(tokenId);

        // Effects — state written before external call (CEI)
        _queue.push(tokenId);
        _queueIndex[tokenId] = _queue.length;  // 1-based
        _mint(msg.sender, TOKENS_PER_CREDIT);
        emit CreditDeposited(tokenId, msg.sender);

        // Interactions — revert here rolls back all effects above (atomicity)
        registry.transferFrom(msg.sender, address(this), tokenId);
    }

    /// @notice ERC721 safe-transfer hook — accepts deposits via safeTransferFrom.
    ///         Users may call registry.safeTransferFrom(user, pool, tokenId) directly
    ///         instead of using deposit(). The pool mints ERC20 to the original sender.
    /// @param  from    Address that initiated the safe transfer (receives ERC20 tokens).
    /// @param  tokenId Token ID being deposited.
    function onERC721Received(
        address,
        address from,
        uint256 tokenId,
        bytes calldata
    ) external returns (bytes4) {
        if (msg.sender != address(registry)) revert WrongRegistry(msg.sender);
        if (_queueIndex[tokenId] != 0)       revert AlreadyInPool(tokenId);
        _validateCredit(tokenId);

        _queue.push(tokenId);
        _queueIndex[tokenId] = _queue.length;
        _mint(from, TOKENS_PER_CREDIT);
        emit CreditDeposited(tokenId, from);

        return IERC721Receiver.onERC721Received.selector;
    }

    // ─────────────────────────────────────────────────────
    //  REDEEM
    // ─────────────────────────────────────────────────────

    /// @notice Burn TOKENS_PER_CREDIT ERC20 tokens and receive a specific CRS credit.
    /// @dev    The credit must be ACTIVE or LISTED at time of redemption — suspended
    ///         credits cannot be transferred and will revert. Users should redeem a
    ///         different token from the pool in that case.
    /// @param  tokenId Token ID of the CRS credit to redeem.
    function redeem(uint256 tokenId) external {
        if (_queueIndex[tokenId] == 0) revert NotInPool(tokenId);

        CarbonCredit memory c = registry.getCredit(tokenId);
        if (c.status != TokenStatus.ACTIVE && c.status != TokenStatus.LISTED)
            revert CreditNotTransferable(tokenId);

        // Effects before external call (CEI)
        _removeFromQueue(tokenId);
        _burn(msg.sender, TOKENS_PER_CREDIT);
        emit CreditRedeemed(tokenId, msg.sender);

        // Interactions
        registry.transferFrom(address(this), msg.sender, tokenId);
    }

    // ─────────────────────────────────────────────────────
    //  VIEWS
    // ─────────────────────────────────────────────────────

    /// @notice Number of credits currently held in the pool.
    function poolSize() external view returns (uint256) {
        return _queue.length;
    }

    /// @notice Full list of token IDs currently held in the pool.
    function poolTokens() external view returns (uint256[] memory) {
        return _queue;
    }

    /// @notice Check whether a specific tokenId is currently in the pool.
    function isInPool(uint256 tokenId) external view returns (bool) {
        return _queueIndex[tokenId] > 0;
    }

    // ─────────────────────────────────────────────────────
    //  INTERNAL
    // ─────────────────────────────────────────────────────

    /// @dev Validate credit eligibility against status and vintage filter.
    function _validateCredit(uint256 tokenId) private view {
        CarbonCredit memory c = registry.getCredit(tokenId);
        if (c.status != TokenStatus.ACTIVE && c.status != TokenStatus.LISTED)
            revert NotEligible(tokenId);
        if (vintageFrom > 0 && c.vintageYear < vintageFrom) revert VintageTooOld(c.vintageYear, vintageFrom);
        if (vintageTo   > 0 && c.vintageYear > vintageTo)   revert VintageTooNew(c.vintageYear, vintageTo);
    }

    /// @dev O(1) removal from _queue using swap-and-pop.
    function _removeFromQueue(uint256 tokenId) private {
        uint256 idx     = _queueIndex[tokenId] - 1;  // convert to 0-based
        uint256 lastIdx = _queue.length - 1;
        if (idx != lastIdx) {
            uint256 last = _queue[lastIdx];
            _queue[idx]       = last;
            _queueIndex[last] = idx + 1;              // restore 1-based index
        }
        _queue.pop();
        delete _queueIndex[tokenId];
    }
}
