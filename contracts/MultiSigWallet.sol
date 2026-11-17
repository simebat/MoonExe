// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title MultiSigWallet
 * @notice Minimal M-of-N multisig wallet with an optional execution delay (timelock).
 *         Intended to be the owner of USDTStaking.
 *
 *  - Any owner can submit a transaction (target, BNB value, calldata). The submitter's
 *    confirmation is recorded automatically.
 *  - Owners confirm or revoke. A transaction can be executed by any owner once
 *    `threshold` CURRENT owners have confirmed it and `delay` seconds have passed
 *    since it was submitted.
 *  - The owner set, threshold and delay can only be changed by the wallet itself,
 *    i.e. through a transaction that went through the same approval process.
 *  - Removing an owner invalidates their confirmations, including if the same address
 *    is added back later.
 */
contract MultiSigWallet is ReentrancyGuard {
    struct Transaction {
        address to;
        uint256 value;
        bytes data;
        uint64 submittedAt;
        bool executed;
    }

    uint256 public constant MAX_OWNERS = 20;
    uint256 public constant MAX_DELAY = 30 days;

    address[] private _owners;
    mapping(address => bool) public isOwner;
    uint256 public threshold;
    uint256 public delay;

    Transaction[] private _transactions;

    /// @dev Incremented each time an address is added as owner, so confirmations made
    ///      during an earlier ownership period stop counting.
    mapping(address => uint256) private _ownerEpoch;
    /// @dev txId => owner => epoch the confirmation was made in (0 = not confirmed).
    mapping(uint256 => mapping(address => uint256)) private _confirmedEpoch;

    event Deposit(address indexed from, uint256 amount);
    event Submitted(uint256 indexed txId, address indexed owner, address indexed to, uint256 value, bytes data);
    event Confirmed(uint256 indexed txId, address indexed owner);
    event Revoked(uint256 indexed txId, address indexed owner);
    event Executed(uint256 indexed txId, address indexed owner);
    event OwnerAdded(address indexed owner);
    event OwnerRemoved(address indexed owner);
    event ThresholdChanged(uint256 threshold);
    event DelayChanged(uint256 delay);

    error NotOwner();
    error NotSelf();
    error ZeroAddress();
    error InvalidOwnerCount();
    error InvalidOwner();
    error DuplicateOwner();
    error InvalidThreshold();
    error DelayTooLong();
    error TxNotFound();
    error AlreadyExecuted();
    error AlreadyConfirmed();
    error NotConfirmed();
    error NotEnoughConfirmations();
    error DelayNotElapsed();
    error ExecutionFailed();

    modifier onlyOwner() {
        if (!isOwner[msg.sender]) revert NotOwner();
        _;
    }

    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotSelf();
        _;
    }

    modifier pending(uint256 txId) {
        if (txId >= _transactions.length) revert TxNotFound();
        if (_transactions[txId].executed) revert AlreadyExecuted();
        _;
    }

    /// @param owners_ Initial signers (1 to MAX_OWNERS, no duplicates, no zero address)
    /// @param threshold_ Confirmations required to execute (1 to owners_.length)
    /// @param delay_ Seconds between submission and earliest execution (0 to MAX_DELAY)
    constructor(address[] memory owners_, uint256 threshold_, uint256 delay_) {
        if (owners_.length == 0 || owners_.length > MAX_OWNERS) revert InvalidOwnerCount();
        for (uint256 i = 0; i < owners_.length; i++) {
            _addOwner(owners_[i]);
        }
        _setThreshold(threshold_);
        _setDelay(delay_);
    }

    receive() external payable {
        emit Deposit(msg.sender, msg.value);
    }

    // ---------------------------------------------------------------------
    // Owner actions
    // ---------------------------------------------------------------------

    function submit(address to, uint256 value, bytes calldata data) external onlyOwner returns (uint256 txId) {
        if (to == address(0)) revert ZeroAddress();
        txId = _transactions.length;
        _transactions.push(
            Transaction({to: to, value: value, data: data, submittedAt: uint64(block.timestamp), executed: false})
        );
        emit Submitted(txId, msg.sender, to, value, data);
        _confirm(txId);
    }

    function confirm(uint256 txId) external onlyOwner pending(txId) {
        if (isConfirmed(txId, msg.sender)) revert AlreadyConfirmed();
        _confirm(txId);
    }

    function revoke(uint256 txId) external onlyOwner pending(txId) {
        if (!isConfirmed(txId, msg.sender)) revert NotConfirmed();
        _confirmedEpoch[txId][msg.sender] = 0;
        emit Revoked(txId, msg.sender);
    }

    function execute(uint256 txId) external onlyOwner pending(txId) nonReentrant {
        Transaction storage t = _transactions[txId];
        if (confirmationCount(txId) < threshold) revert NotEnoughConfirmations();
        if (block.timestamp < uint256(t.submittedAt) + delay) revert DelayNotElapsed();

        t.executed = true;
        (bool ok, bytes memory ret) = t.to.call{value: t.value}(t.data);
        if (!ok) {
            if (ret.length == 0) revert ExecutionFailed();
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        emit Executed(txId, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Self-administration (only via an executed multisig transaction)
    // ---------------------------------------------------------------------

    function addOwner(address owner) external onlySelf {
        if (_owners.length >= MAX_OWNERS) revert InvalidOwnerCount();
        _addOwner(owner);
    }

    function removeOwner(address owner) external onlySelf {
        if (_owners.length - 1 < threshold) revert InvalidThreshold();
        _removeOwner(owner);
    }

    function replaceOwner(address oldOwner, address newOwner) external onlySelf {
        _removeOwner(oldOwner);
        _addOwner(newOwner);
    }

    function changeThreshold(uint256 threshold_) external onlySelf {
        _setThreshold(threshold_);
    }

    function changeDelay(uint256 delay_) external onlySelf {
        _setDelay(delay_);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getOwners() external view returns (address[] memory) {
        return _owners;
    }

    function transactionCount() external view returns (uint256) {
        return _transactions.length;
    }

    function getTransaction(uint256 txId)
        external
        view
        returns (address to, uint256 value, bytes memory data, uint256 submittedAt, bool executed, uint256 confirmations)
    {
        if (txId >= _transactions.length) revert TxNotFound();
        Transaction storage t = _transactions[txId];
        return (t.to, t.value, t.data, t.submittedAt, t.executed, confirmationCount(txId));
    }

    /// @notice True if `owner` is a current owner and has a live confirmation on `txId`.
    function isConfirmed(uint256 txId, address owner) public view returns (bool) {
        return isOwner[owner] && _confirmedEpoch[txId][owner] == _ownerEpoch[owner];
    }

    /// @notice Number of current owners whose confirmation on `txId` is live.
    function confirmationCount(uint256 txId) public view returns (uint256 count) {
        for (uint256 i = 0; i < _owners.length; i++) {
            if (_confirmedEpoch[txId][_owners[i]] == _ownerEpoch[_owners[i]]) count++;
        }
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _confirm(uint256 txId) private {
        _confirmedEpoch[txId][msg.sender] = _ownerEpoch[msg.sender];
        emit Confirmed(txId, msg.sender);
    }

    function _addOwner(address owner) private {
        if (owner == address(0) || owner == address(this)) revert InvalidOwner();
        if (isOwner[owner]) revert DuplicateOwner();
        isOwner[owner] = true;
        _ownerEpoch[owner]++; // starts at 1, so an unset confirmation (0) never matches
        _owners.push(owner);
        emit OwnerAdded(owner);
    }

    function _removeOwner(address owner) private {
        if (!isOwner[owner]) revert InvalidOwner();
        isOwner[owner] = false;
        uint256 last = _owners.length - 1;
        for (uint256 i = 0; i <= last; i++) {
            if (_owners[i] == owner) {
                _owners[i] = _owners[last];
                _owners.pop();
                break;
            }
        }
        emit OwnerRemoved(owner);
    }

    function _setThreshold(uint256 threshold_) private {
        if (threshold_ == 0 || threshold_ > _owners.length) revert InvalidThreshold();
        threshold = threshold_;
        emit ThresholdChanged(threshold_);
    }

    function _setDelay(uint256 delay_) private {
        if (delay_ > MAX_DELAY) revert DelayTooLong();
        delay = delay_;
        emit DelayChanged(delay_);
    }
}
