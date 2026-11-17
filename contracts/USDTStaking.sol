// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title USDTStaking (V1, non-upgradeable)
 * @notice Fixed-term USDT staking vault for BNB Smart Chain (BEP20 USDT).
 *
 *  - Lock: 90 days. Reward: 12% APR, simple interest, fixed at deposit time.
 *  - Minimum deposit: 100 USDT. No maximum.
 *  - One open position per wallet; no top-ups.
 *  - The full promised reward is reserved from company-funded USDT at deposit time;
 *    deposits are rejected when the free reward reserve is insufficient.
 *  - Single withdrawal at/after maturity: principal + reward. No early or partial
 *    withdrawal, no claims, no compounding, no extra reward after maturity.
 *  - Owner (company multisig) can: fund rewards, pause/unpause NEW deposits,
 *    withdraw unused reward funds, and rescue non-USDT tokens / BNB sent by mistake.
 *    Owner can never touch user principal or reserved rewards, or alter positions.
 *  - All terms are constants; nothing can be changed after deployment.
 */
contract USDTStaking is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Immutable terms
    // ---------------------------------------------------------------------

    /// @notice BEP20 USDT on BNB Smart Chain: 0x55d398326f99059fF775485246999027B3197955 (18 decimals)
    IERC20 public immutable usdt;

    uint256 public constant LOCK_DURATION = 90 days;
    uint256 public constant APR_BPS = 1_200; // 12.00%
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant YEAR = 365 days;
    /// @notice Decimals the staking token must have; MIN_DEPOSIT is denominated in these units.
    uint8 public constant TOKEN_DECIMALS = 18;
    uint256 public constant MIN_DEPOSIT = 100 * 10 ** TOKEN_DECIMALS; // 100 USDT (BSC USDT has 18 decimals)

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------

    struct Position {
        uint256 principal;
        uint256 reward;
        uint64 startTime;
        uint64 maturity;
    }

    /// @notice Open position per wallet (principal == 0 means no open position).
    mapping(address => Position) public positions;

    /// @notice Sum of principal of all open positions.
    uint256 public totalPrincipal;

    /// @notice Sum of promised rewards of all open positions.
    uint256 public totalReservedRewards;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event Staked(address indexed user, uint256 principal, uint256 reward, uint256 maturity);
    event Withdrawn(address indexed user, uint256 principal, uint256 reward);
    event RewardsFunded(address indexed from, uint256 amount);
    event UnusedRewardsWithdrawn(address indexed to, uint256 amount);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);
    event NativeRescued(address indexed to, uint256 amount);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error BelowMinimum();
    error PositionAlreadyOpen();
    error NoOpenPosition();
    error NotMatured();
    error InsufficientRewardReserve();
    error UnexpectedTransferAmount();
    error CannotRescueStakingToken();
    error RenounceDisabled();
    error NativeTransferFailed();
    error UnsupportedTokenDecimals(uint8 decimals);

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /// @param usdt_ USDT token address (BSC mainnet: 0x55d398326f99059fF775485246999027B3197955)
    /// @param multisig_ Company multisignature wallet that becomes owner
    constructor(address usdt_, address multisig_) Ownable(multisig_) {
        if (usdt_ == address(0)) revert ZeroAddress();
        // MIN_DEPOSIT assumes 18 decimals; refuse any token that would misprice it.
        uint8 decimals = IERC20Metadata(usdt_).decimals();
        if (decimals != TOKEN_DECIMALS) revert UnsupportedTokenDecimals(decimals);
        usdt = IERC20(usdt_);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice USDT in the vault not committed to principal or promised rewards.
    function availableRewards() public view returns (uint256) {
        uint256 committed = totalPrincipal + totalReservedRewards;
        uint256 balance = usdt.balanceOf(address(this));
        return balance > committed ? balance - committed : 0;
    }

    /// @notice Reward promised for a given principal over the fixed lock period.
    function calculateReward(uint256 amount) public pure returns (uint256) {
        return (amount * APR_BPS * LOCK_DURATION) / (BPS_DENOMINATOR * YEAR);
    }

    // ---------------------------------------------------------------------
    // User actions
    // ---------------------------------------------------------------------

    /// @notice Open a 90-day position. Caller must approve `amount` USDT first.
    function stake(uint256 amount) external nonReentrant whenNotPaused {
        if (amount < MIN_DEPOSIT) revert BelowMinimum();
        if (positions[msg.sender].principal != 0) revert PositionAlreadyOpen();

        uint256 reward = calculateReward(amount);
        if (reward > availableRewards()) revert InsufficientRewardReserve();

        uint256 before = usdt.balanceOf(address(this));
        usdt.safeTransferFrom(msg.sender, address(this), amount);
        if (usdt.balanceOf(address(this)) - before != amount) revert UnexpectedTransferAmount();

        uint64 maturity = uint64(block.timestamp + LOCK_DURATION);
        positions[msg.sender] = Position({
            principal: amount,
            reward: reward,
            startTime: uint64(block.timestamp),
            maturity: maturity
        });
        totalPrincipal += amount;
        totalReservedRewards += reward;

        emit Staked(msg.sender, amount, reward, maturity);
    }

    /// @notice Withdraw principal + reward once, at or after maturity. Works while paused.
    function withdraw() external nonReentrant {
        Position memory p = positions[msg.sender];
        if (p.principal == 0) revert NoOpenPosition();
        if (block.timestamp < p.maturity) revert NotMatured();

        delete positions[msg.sender];
        totalPrincipal -= p.principal;
        totalReservedRewards -= p.reward;

        usdt.safeTransfer(msg.sender, p.principal + p.reward);

        emit Withdrawn(msg.sender, p.principal, p.reward);
    }

    // ---------------------------------------------------------------------
    // Owner (company multisig) actions
    // ---------------------------------------------------------------------

    /// @notice Pull USDT from the owner into the reward reserve. Owner must approve first.
    /// @dev USDT sent directly to the contract is also counted as reward reserve.
    function fundRewards(uint256 amount) external onlyOwner {
        if (amount == 0) revert ZeroAmount();
        usdt.safeTransferFrom(msg.sender, address(this), amount);
        emit RewardsFunded(msg.sender, amount);
    }

    /// @notice Stop accepting new deposits. Matured withdrawals remain available.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Withdraw USDT that is not principal and not reserved for promised rewards.
    /// @dev Also recovers USDT sent to the contract by mistake, since it is counted as unused.
    function withdrawUnusedRewards(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > availableRewards()) revert InsufficientRewardReserve();
        usdt.safeTransfer(to, amount);
        emit UnusedRewardsWithdrawn(to, amount);
    }

    /// @notice Recover any non-USDT BEP20 token sent to this contract by mistake.
    function rescueToken(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(usdt)) revert CannotRescueStakingToken();
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }

    /// @notice Recover BNB force-sent to this contract (it has no payable entry points).
    function rescueNative(address payable to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = address(this).balance;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
        emit NativeRescued(to, amount);
    }

    /// @dev Disabled so the vault can never be left without an admin to unpause/rescue.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }
}
