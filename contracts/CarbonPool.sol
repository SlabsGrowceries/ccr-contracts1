// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "./CRSToken.sol";
import "./SovereignRegistry.sol";
import "./IAllowlist.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/// @title Carbon Pool — ERC20 Fungible Wrapper for CRS Carbon Credits
/// @notice Wraps CRS ERC721 tokens from one or more SovereignRegistries into
///         fungible ERC20 pool tokens, enabling DeFi composability: pool tokens
///         can be traded on AMMs, used as collateral, or redeemed back for
///         individual CRS credits on demand.
///
///         Multi-registry: the pool owner can approve multiple SovereignRegistry
///         addresses. This enables a true multi-sovereign basket — e.g. a pool
///         combining DRC + Liberia + Gabon credits — analogous to Toucan's BCT
///         pool across multiple project types, but backed by government-sovereign
///         on-chain registries with full MRV verification.
///
///         ERC-2612 Permit: pool ERC20 tokens support gasless approvals via
///         off-chain signatures, removing the two-transaction (approve + action)
///         friction that Toucan pools still require.
///
///         Deposit paths:
///           A) registry.approve(pool, tokenId) → pool.deposit(registryAddr, tokenId)
///           B) registry.safeTransferFrom(user, pool, tokenId) (triggers onERC721Received)
///
///         Redeem path:
///           pool.redeem(tokenId) — burns TOKENS_PER_CREDIT ERC20, returns specific ERC721
///
///         Optional vintage filter: set vintageFrom / vintageTo to restrict which
///         credits are eligible (e.g. a "Post-2025 Vintage" pool product).
///         Zero means no filter applied on that bound.
contract CarbonPool is ERC20, ERC20Permit, IERC721Receiver, Ownable, Pausable {

    // ─────────────────────────────────────────────────────
    //  ERRORS
    // ─────────────────────────────────────────────────────

    /// @param registry Address that is not an approved registry for this pool
    error RegistryNotApproved(address registry);
    /// @param tokenId Token that is already in the pool
    error AlreadyInPool(uint256 tokenId);
    /// @param tokenId Token that is not eligible (wrong status or vintage)
    error NotEligible(uint256 tokenId);
    /// @param year    Vintage year of the credit
    /// @param minimum Pool's lower vintage bound
    error VintageTooOld(uint16 year, uint16 minimum);
    /// @param year    Vintage year of the credit
    /// @param maximum Pool's upper vintage bound
    error VintageTooNew(uint16 year, uint16 maximum);
    /// @param caller Address that called onERC721Received — not an approved registry
    error WrongRegistry(address caller);
    /// @param tokenId Token that is not currently in the pool
    error NotInPool(uint256 tokenId);
    /// @param tokenId Token whose status prevents transfer (retired or suspended)
    error CreditNotTransferable(uint256 tokenId);
    /// @param account Address blocked by the pool's KYC/AML allowlist
    error NotAllowlisted(address account);
    /// @param feeBps  Fee that was supplied
    /// @param maximum Hard cap — MAX_FEE_BPS
    error FeeTooHigh(uint16 feeBps, uint16 maximum);

    // ─────────────────────────────────────────────────────
    //  STATE
    // ─────────────────────────────────────────────────────

    /// @notice Optional KYC/AML gate — zero address disables screening.
    IAllowlist public allowlist;

    /// @notice Set of approved SovereignRegistry addresses for this pool.
    mapping(address => bool) public approvedRegistries;

    /// @notice Vintage year lower bound — 0 = no lower limit
    uint16 public immutable vintageFrom;
    /// @notice Vintage year upper bound — 0 = no upper limit
    uint16 public immutable vintageTo;

    /// @notice 1 CRS ERC721 credit = TOKENS_PER_CREDIT pool ERC20 tokens
    uint256 public constant TOKENS_PER_CREDIT = 1e18;

    /// @notice Hard cap on fees — 10% maximum; prevents owner from extracting depositor value.
    uint16 public constant MAX_FEE_BPS = 1_000;

    /// @notice Fee charged to depositors in basis points of TOKENS_PER_CREDIT.
    ///         E.g. 30 = 0.30%. Depositor receives TOKENS_PER_CREDIT minus this amount.
    ///         Fee is only collected when feeRecipient is non-zero.
    uint16 public depositFeeBps;

    /// @notice Fee charged to redeemers in basis points of TOKENS_PER_CREDIT.
    ///         E.g. 50 = 0.50%. Redeemer pays TOKENS_PER_CREDIT + this amount.
    ///         Fee is only collected when feeRecipient is non-zero.
    uint16 public redeemFeeBps;

    /// @notice Address that receives protocol fees.
    ///         Zero address disables fee collection even if feeBps > 0.
    address public feeRecipient;

    /// @notice Accounts whose deposits and redemptions are permanently fee-exempt.
    ///         Use for founding-partner waivers. Fee rates remain visible on-chain —
    ///         the waiver is a provable grant, not a silent discount.
    mapping(address => bool) public feeWaived;

    /// @dev Token IDs currently held in the pool (append-on-deposit, swap-pop-on-redeem)
    uint256[] private _queue;

    /// @dev 1-based position of tokenId in _queue; 0 means not in pool
    mapping(uint256 => uint256) private _queueIndex;

    /// @dev Tracks which registry each deposited token belongs to, for correct redemption routing.
    mapping(uint256 => address) private _tokenSource;

    // ─────────────────────────────────────────────────────
    //  EVENTS
    // ─────────────────────────────────────────────────────

    event RegistryAdded(address indexed registry);
    event RegistryRemoved(address indexed registry);
    event AllowlistUpdated(address indexed oldList, address indexed newList);
    event FeesUpdated(uint16 depositFeeBps, uint16 redeemFeeBps);
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    event FeeWaiverUpdated(address indexed account, bool waived);
    event CreditDeposited(uint256 indexed tokenId, address indexed registry, address indexed depositor);
    event CreditRedeemed(uint256 indexed tokenId, address indexed registry, address indexed redeemer);

    // ─────────────────────────────────────────────────────
    //  CONSTRUCTOR
    // ─────────────────────────────────────────────────────

    /// @param _registry    Initial SovereignRegistry address (at least one required).
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
    ) ERC20(name, symbol) ERC20Permit(name) Ownable(msg.sender) {
        if (_registry == address(0)) revert RegistryNotApproved(_registry);
        approvedRegistries[_registry] = true;
        emit RegistryAdded(_registry);
        vintageFrom = _vintageFrom;
        vintageTo   = _vintageTo;
    }

    // ─────────────────────────────────────────────────────
    //  REGISTRY MANAGEMENT — pool owner only
    // ─────────────────────────────────────────────────────

    /// @notice Approve an additional SovereignRegistry to deposit credits into this pool.
    ///         Enables multi-sovereign baskets: combine DRC + Liberia + Gabon credits.
    /// @param  registry Address of the SovereignRegistry to approve.
    function addRegistry(address registry) external onlyOwner {
        if (registry == address(0)) revert RegistryNotApproved(registry);
        approvedRegistries[registry] = true;
        emit RegistryAdded(registry);
    }

    /// @notice Remove a registry from the approved set.
    ///         Credits already deposited from this registry remain in the pool
    ///         and can still be redeemed; only new deposits are blocked.
    /// @param  registry Address of the SovereignRegistry to remove.
    function removeRegistry(address registry) external onlyOwner {
        approvedRegistries[registry] = false;
        emit RegistryRemoved(registry);
    }

    // ─────────────────────────────────────────────────────
    //  KYC / AML ALLOWLIST — pool owner only
    // ─────────────────────────────────────────────────────

    /// @notice Set the KYC/AML allowlist for this pool. Pass address(0) to disable.
    ///         When set, depositors and redeemers must pass isAllowed() before interacting.
    ///         Aligns with FATF guidance for VASPs operating DeFi liquidity pools.
    /// @param  newAllowlist Address of an IAllowlist implementation, or zero to disable.
    function setAllowlist(address newAllowlist) external onlyOwner {
        address old = address(allowlist);
        allowlist = IAllowlist(newAllowlist);
        emit AllowlistUpdated(old, newAllowlist);
    }

    // ─────────────────────────────────────────────────────
    //  FEE MANAGEMENT — pool owner only
    // ─────────────────────────────────────────────────────

    /// @notice Set deposit and redemption fees.
    ///         Fees are denominated in basis points of TOKENS_PER_CREDIT (100 bps = 1%).
    ///         Fees are only collected when feeRecipient is non-zero.
    ///         Hard cap of MAX_FEE_BPS (10%) prevents extracting depositor value.
    ///
    ///         Recommended starting points:
    ///           depositFeeBps = 0       (no deposit friction — encourages liquidity)
    ///           redeemFeeBps  = 30–100  (0.3–1% — Toucan charges ~50bps on redemption)
    ///
    /// @param  _depositFeeBps Fee on deposit in basis points (0 = free).
    /// @param  _redeemFeeBps  Fee on redemption in basis points (0 = free).
    function setFees(uint16 _depositFeeBps, uint16 _redeemFeeBps) external onlyOwner {
        if (_depositFeeBps > MAX_FEE_BPS) revert FeeTooHigh(_depositFeeBps, MAX_FEE_BPS);
        if (_redeemFeeBps  > MAX_FEE_BPS) revert FeeTooHigh(_redeemFeeBps,  MAX_FEE_BPS);
        depositFeeBps = _depositFeeBps;
        redeemFeeBps  = _redeemFeeBps;
        emit FeesUpdated(_depositFeeBps, _redeemFeeBps);
    }

    /// @notice Set the address that receives protocol fees.
    ///         Pass address(0) to suspend fee collection without changing the fee rates.
    /// @param  recipient The fee recipient address.
    function setFeeRecipient(address recipient) external onlyOwner {
        address old = feeRecipient;
        feeRecipient = recipient;
        emit FeeRecipientUpdated(old, recipient);
    }

    /// @notice Grant or revoke a fee waiver for a specific account.
    ///         Waived accounts deposit and redeem without paying fees even when
    ///         global fee rates are non-zero. Use for founding-partner agreements.
    /// @param  account Address to waive.
    /// @param  waived  True to grant waiver, false to revoke.
    function setFeeWaiver(address account, bool waived) external onlyOwner {
        feeWaived[account] = waived;
        emit FeeWaiverUpdated(account, waived);
    }

    // ─────────────────────────────────────────────────────
    //  EMERGENCY STOP — pool owner only
    // ─────────────────────────────────────────────────────

    /// @notice Pause all deposits and redemptions — emergency stop.
    function pause()   external onlyOwner { _pause(); }

    /// @notice Resume normal pool operations.
    function unpause() external onlyOwner { _unpause(); }

    // ─────────────────────────────────────────────────────
    //  DEPOSIT
    // ─────────────────────────────────────────────────────

    /// @notice Deposit a CRS credit into the pool and receive TOKENS_PER_CREDIT ERC20 tokens.
    /// @dev    Caller must first call registry.approve(address(this), tokenId).
    ///         Follows CEI: all state changes before the external transferFrom call.
    /// @param  registryAddr Address of the SovereignRegistry that holds the credit.
    /// @param  tokenId      Token ID of the CRS credit to deposit.
    function deposit(address registryAddr, uint256 tokenId) external whenNotPaused {
        if (!approvedRegistries[registryAddr]) revert RegistryNotApproved(registryAddr);
        if (address(allowlist) != address(0) && !allowlist.isAllowed(msg.sender))
            revert NotAllowlisted(msg.sender);
        _validateCredit(registryAddr, tokenId);
        if (_queueIndex[tokenId] != 0) revert AlreadyInPool(tokenId);

        // Effects — state written before external call (CEI)
        _queue.push(tokenId);
        _queueIndex[tokenId] = _queue.length;  // 1-based
        _tokenSource[tokenId] = registryAddr;

        uint256 fee = _depositFee(msg.sender);
        _mint(msg.sender, TOKENS_PER_CREDIT - fee);
        if (fee > 0) _mint(feeRecipient, fee);
        emit CreditDeposited(tokenId, registryAddr, msg.sender);

        // Interactions — revert here rolls back all effects above (atomicity)
        SovereignRegistry(registryAddr).transferFrom(msg.sender, address(this), tokenId);
    }

    /// @notice ERC721 safe-transfer hook — accepts deposits via safeTransferFrom.
    ///         Users may call registry.safeTransferFrom(user, pool, tokenId) directly
    ///         instead of using deposit(). The pool mints ERC20 to the original sender.
    ///         msg.sender must be an approved registry — the check replaces the old
    ///         single-registry equality check with a multi-registry approval lookup.
    /// @param  from    Address that initiated the safe transfer (receives ERC20 tokens).
    /// @param  tokenId Token ID being deposited.
    function onERC721Received(
        address,
        address from,
        uint256 tokenId,
        bytes calldata
    ) external whenNotPaused returns (bytes4) {
        if (!approvedRegistries[msg.sender]) revert WrongRegistry(msg.sender);
        if (address(allowlist) != address(0) && !allowlist.isAllowed(from))
            revert NotAllowlisted(from);
        if (_queueIndex[tokenId] != 0)       revert AlreadyInPool(tokenId);
        _validateCredit(msg.sender, tokenId);

        _queue.push(tokenId);
        _queueIndex[tokenId] = _queue.length;
        _tokenSource[tokenId] = msg.sender;

        uint256 fee = _depositFee(from);
        _mint(from, TOKENS_PER_CREDIT - fee);
        if (fee > 0) _mint(feeRecipient, fee);
        emit CreditDeposited(tokenId, msg.sender, from);

        return IERC721Receiver.onERC721Received.selector;
    }

    // ─────────────────────────────────────────────────────
    //  REDEEM
    // ─────────────────────────────────────────────────────

    /// @notice Burn TOKENS_PER_CREDIT ERC20 tokens and receive a specific CRS credit.
    /// @dev    The token is routed back through its source registry (tracked at deposit time),
    ///         so multi-registry pools correctly return each token to the right chain.
    ///         The credit must be ACTIVE or LISTED — suspended credits revert.
    /// @param  tokenId Token ID of the CRS credit to redeem.
    function redeem(uint256 tokenId) external whenNotPaused {
        if (_queueIndex[tokenId] == 0) revert NotInPool(tokenId);
        if (address(allowlist) != address(0) && !allowlist.isAllowed(msg.sender))
            revert NotAllowlisted(msg.sender);

        address registryAddr = _tokenSource[tokenId];
        CarbonCredit memory c = SovereignRegistry(registryAddr).getCredit(tokenId);
        if (c.status != TokenStatus.ACTIVE && c.status != TokenStatus.LISTED)
            revert CreditNotTransferable(tokenId);

        // Effects before external call (CEI)
        uint256 fee = _redeemFee(msg.sender);
        _removeFromQueue(tokenId);
        delete _tokenSource[tokenId];
        _burn(msg.sender, TOKENS_PER_CREDIT);
        if (fee > 0) _transfer(msg.sender, feeRecipient, fee);
        emit CreditRedeemed(tokenId, registryAddr, msg.sender);

        // Interactions
        SovereignRegistry(registryAddr).transferFrom(address(this), msg.sender, tokenId);
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

    /// @notice The registry address that issued a token currently in the pool.
    /// @param  tokenId Token to look up; must be in the pool.
    function tokenSource(uint256 tokenId) external view returns (address) {
        if (_queueIndex[tokenId] == 0) revert NotInPool(tokenId);
        return _tokenSource[tokenId];
    }

    /// @notice What a redeemer must hold to call redeem() successfully (standard rate).
    ///         Waived accounts pay no fee — pass the caller address to check on-chain.
    ///         Total = TOKENS_PER_CREDIT (burned) + fee (transferred to feeRecipient).
    /// @return total Full token amount required in caller's wallet.
    /// @return fee   Portion routed to feeRecipient; zero when feeRecipient is unset.
    function redeemCost() external view returns (uint256 total, uint256 fee) {
        fee   = _redeemFee(address(0));
        total = TOKENS_PER_CREDIT + fee;
    }

    /// @notice What a depositor receives after the deposit fee (standard rate).
    ///         Waived accounts receive full TOKENS_PER_CREDIT.
    /// @return received Tokens minted to the depositor.
    /// @return fee      Tokens minted to feeRecipient; zero when feeRecipient is unset.
    function depositReturn() external view returns (uint256 received, uint256 fee) {
        fee      = _depositFee(address(0));
        received = TOKENS_PER_CREDIT - fee;
    }

    /// @notice Inspect the full CarbonCredit data for a token currently in the pool.
    /// @dev    Call this before redeem() to verify vintage, project, tonnage, and
    ///         any other quality attributes before committing the transaction.
    /// @param  tokenId Token ID to inspect; must be in the pool.
    /// @return The full CarbonCredit struct as stored in the source registry.
    function previewCredit(uint256 tokenId) external view returns (CarbonCredit memory) {
        if (_queueIndex[tokenId] == 0) revert NotInPool(tokenId);
        return SovereignRegistry(_tokenSource[tokenId]).getCredit(tokenId);
    }

    // ─────────────────────────────────────────────────────
    //  INTERNAL
    // ─────────────────────────────────────────────────────

    /// @dev Returns the deposit fee in pool tokens for a specific account.
    ///      Returns zero when depositFeeBps is 0, feeRecipient is unset, or account is fee-waived.
    /// @param  account Address of the depositor; pass address(0) for the standard (non-waived) rate.
    /// @return         Fee amount in pool-token wei (18 decimals) deducted from TOKENS_PER_CREDIT.
    function _depositFee(address account) private view returns (uint256) {
        if (depositFeeBps == 0 || feeRecipient == address(0) || feeWaived[account]) return 0;
        return TOKENS_PER_CREDIT * depositFeeBps / 10_000;
    }

    /// @dev Returns the redemption fee in pool tokens for a specific account.
    ///      Returns zero when redeemFeeBps is 0, feeRecipient is unset, or account is fee-waived.
    /// @param  account Address of the redeemer; pass address(0) for the standard (non-waived) rate.
    /// @return         Fee amount in pool-token wei (18 decimals) transferred from redeemer to feeRecipient.
    function _redeemFee(address account) private view returns (uint256) {
        if (redeemFeeBps == 0 || feeRecipient == address(0) || feeWaived[account]) return 0;
        return TOKENS_PER_CREDIT * redeemFeeBps / 10_000;
    }

    /// @dev Validate credit eligibility against status and vintage filter.
    function _validateCredit(address registryAddr, uint256 tokenId) private view {
        CarbonCredit memory c = SovereignRegistry(registryAddr).getCredit(tokenId);
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
