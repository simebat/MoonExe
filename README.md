# MoonExe USDT Staking (BSC)

Fixed-term staking for BEP20 USDT on BNB Smart Chain. Users lock USDT for 90 days and get it back with 12% APR (simple interest) in one withdrawal at the end.

USDT on BSC: `0x55d398326f99059fF775485246999027B3197955` (18 decimals)

## Terms

These are constants in the contract and can't be changed after deployment.

- Lock period: 90 days
- APR: 12%, so a full term pays 1000 × 0.12 × 90 / 365 ≈ 29.59 USDT per 1000 staked
- Minimum stake: 100 USDT
- No maximum

The minimum is written for an 18-decimal token. The constructor reads the token's `decimals()` and refuses to deploy unless it returns 18, so the contract can't be deployed against a token that would misprice the minimum.

## How it works

Each wallet can have one open position at a time. You can't top it up. Once it's withdrawn, the wallet can stake again.

The reward is fixed the moment you stake, and it has to already be in the contract. When someone stakes, the contract checks that there's enough unallocated reward USDT to cover their full reward and sets that amount aside. If there isn't enough, the stake is rejected. So the company has to fund rewards before anyone can deposit.

After 90 days the user calls `withdraw()` and gets principal + reward in one transfer. There's no early exit, no partial withdrawal and no compounding. Leaving the money in longer doesn't earn anything extra.

## Admin

The owner is meant to be the company multisig. It can:

- `fundRewards(amount)`: add USDT to the reward pool (approve first)
- `pause()` / `unpause()`: stop or resume new stakes. Withdrawals keep working while paused.
- `withdrawUnusedRewards(to, amount)`: take back reward USDT that isn't reserved for anyone
- `rescueToken(token, to, amount)`: recover any other token sent here by mistake (not USDT)
- `rescueNative(to)`: recover BNB stuck in the contract

The owner can't touch staked principal or rewards that are already promised, and can't edit anyone's position. USDT sent straight to the contract by mistake just counts as unused reward funds, so it comes back out through `withdrawUnusedRewards`.

Ownership transfer is two-step (`transferOwnership` then `acceptOwnership` from the new address). `renounceOwnership` is disabled.

The contract isn't upgradeable.

## Contract functions

User:

| Function | Notes |
|---|---|
| `stake(amount)` | approve USDT first |
| `withdraw()` | only after maturity |

Read-only:

| Function | Returns |
|---|---|
| `positions(user)` | principal, reward, startTime, maturity |
| `availableRewards()` | USDT not tied to principal or promised rewards |
| `calculateReward(amount)` | reward a stake of `amount` would get |
| `totalPrincipal()` | sum of open principal |
| `totalReservedRewards()` | sum of promised rewards |

## Setup

```
npm install
npx hardhat compile
npx hardhat test
```

## Deploy

One command deploys the multisig wallet and then the staking contract, owned by that multisig:

```
MULTISIG_OWNERS=0xAAA...,0xBBB...,0xCCC... \
MULTISIG_THRESHOLD=2 \
MULTISIG_DELAY=0 \
PRIVATE_KEY=0x... npm run deploy:bsc
```

- `MULTISIG_OWNERS`: signer addresses, comma-separated (max 20)
- `MULTISIG_THRESHOLD`: confirmations needed to run a transaction. It must be at least 2 when there is more than one owner.
- `MULTISIG_DELAY`: optional timelock in seconds between submitting a transaction and running it (max 30 days, default 0)

To use a multisig you already have (e.g. a Safe) instead, set `MULTISIG_ADDRESS=0x...` and leave out the three variables above. The script refuses an address with no contract code, so a plain wallet can't become owner by mistake.

`BSC_RPC_URL` is optional and defaults to the public BNB Chain endpoint. The deployer only pays gas.

After deploying, the multisig approves USDT to the staking contract and calls `fundRewards` before opening it to users.

## Multisig wallet

`contracts/MultiSigWallet.sol` is a minimal M-of-N wallet:

1. An owner calls `submit(to, value, data)`, which counts as their confirmation too.
2. Other owners call `confirm(txId)`. They can withdraw it with `revoke(txId)` before execution.
3. Once `threshold` current owners have confirmed and `delay` has passed since submission, any owner calls `execute(txId)`.

To change owners, the threshold or the delay, the wallet sends a transaction to itself (`addOwner`, `removeOwner`, `replaceOwner`, `changeThreshold`, `changeDelay`). Removing an owner cancels their pending confirmations.

The delay applies to every transaction, including `pause()`. A long delay means an emergency pause also has to wait.

## Layout

```
contracts/USDTStaking.sol       main contract
contracts/MultiSigWallet.sol    owner multisig
contracts/mocks/                test tokens only, not deployed
test/USDTStaking.test.js
test/MultiSigWallet.test.js
scripts/deploy.js
```

Built with Solidity 0.8.24 and OpenZeppelin Contracts 5.1.0.
