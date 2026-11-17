const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const U = (n) => ethers.parseUnits(String(n), 18);
const DAY = 24 * 60 * 60;

describe("MultiSigWallet", function () {
  // 2-of-3 wallet, no delay, owning a USDTStaking vault
  async function deploy() {
    const [a, b, c, outsider, user] = await ethers.getSigners();
    const Wallet = await ethers.getContractFactory("MultiSigWallet");
    const wallet = await Wallet.deploy([a.address, b.address, c.address], 2, 0);
    const walletAddr = await wallet.getAddress();

    const Token = await ethers.getContractFactory("MockERC20");
    const usdt = await Token.deploy("Tether USD", "USDT");
    const Staking = await ethers.getContractFactory("USDTStaking");
    const staking = await Staking.deploy(await usdt.getAddress(), walletAddr);
    const stakingAddr = await staking.getAddress();

    await usdt.mint(walletAddr, U(10_000));
    await usdt.mint(user.address, U(10_000));
    await usdt.connect(user).approve(stakingAddr, ethers.MaxUint256);
    return { wallet, walletAddr, staking, stakingAddr, usdt, a, b, c, outsider, user };
  }

  // submit from `by`, returns the tx id
  async function submit(wallet, by, to, data, value = 0n) {
    const id = await wallet.transactionCount();
    await wallet.connect(by).submit(to, value, data);
    return id;
  }

  // submit + confirm by a second owner + execute
  async function run(f, to, data, value = 0n) {
    const id = await submit(f.wallet, f.a, to, data, value);
    await f.wallet.connect(f.b).confirm(id);
    return f.wallet.connect(f.a).execute(id);
  }

  const selfCall = (wallet, fn, args) => wallet.interface.encodeFunctionData(fn, args);

  it("validates constructor arguments", async function () {
    const [a, b] = await ethers.getSigners();
    const W = await ethers.getContractFactory("MultiSigWallet");
    const w = await W.deploy([a.address], 1, 0);
    await expect(W.deploy([], 1, 0)).to.be.revertedWithCustomError(w, "InvalidOwnerCount");
    await expect(W.deploy([a.address, ethers.ZeroAddress], 1, 0)).to.be.revertedWithCustomError(w, "InvalidOwner");
    await expect(W.deploy([a.address, a.address], 1, 0)).to.be.revertedWithCustomError(w, "DuplicateOwner");
    await expect(W.deploy([a.address, b.address], 0, 0)).to.be.revertedWithCustomError(w, "InvalidThreshold");
    await expect(W.deploy([a.address, b.address], 3, 0)).to.be.revertedWithCustomError(w, "InvalidThreshold");
    await expect(W.deploy([a.address], 1, 31 * DAY)).to.be.revertedWithCustomError(w, "DelayTooLong");
  });

  it("controls the staking vault: approve + fundRewards, pause, unpause", async function () {
    const f = await loadFixture(deploy);
    const { staking, stakingAddr, usdt } = f;
    expect(await staking.owner()).to.equal(f.walletAddr);

    await run(f, await usdt.getAddress(), usdt.interface.encodeFunctionData("approve", [stakingAddr, U(1_000)]));
    await run(f, stakingAddr, staking.interface.encodeFunctionData("fundRewards", [U(1_000)]));
    expect(await staking.availableRewards()).to.equal(U(1_000));

    await run(f, stakingAddr, staking.interface.encodeFunctionData("pause"));
    expect(await staking.paused()).to.equal(true);
    await run(f, stakingAddr, staking.interface.encodeFunctionData("unpause"));
    await expect(staking.connect(f.user).stake(U(100))).to.emit(staking, "Staked");
  });

  it("requires the threshold before execution", async function () {
    const f = await loadFixture(deploy);
    const id = await submit(f.wallet, f.a, f.stakingAddr, f.staking.interface.encodeFunctionData("pause"));
    expect(await f.wallet.confirmationCount(id)).to.equal(1);
    await expect(f.wallet.connect(f.a).execute(id)).to.be.revertedWithCustomError(f.wallet, "NotEnoughConfirmations");
    await f.wallet.connect(f.c).confirm(id);
    await expect(f.wallet.connect(f.c).execute(id)).to.emit(f.wallet, "Executed").withArgs(id, f.c.address);
    await expect(f.wallet.connect(f.a).execute(id)).to.be.revertedWithCustomError(f.wallet, "AlreadyExecuted");
    await expect(f.wallet.connect(f.b).confirm(id)).to.be.revertedWithCustomError(f.wallet, "AlreadyExecuted");
  });

  it("rejects non-owners and bad confirm/revoke calls", async function () {
    const f = await loadFixture(deploy);
    const data = f.staking.interface.encodeFunctionData("pause");
    await expect(f.wallet.connect(f.outsider).submit(f.stakingAddr, 0, data)).to.be.revertedWithCustomError(f.wallet, "NotOwner");
    await expect(f.wallet.connect(f.a).submit(ethers.ZeroAddress, 0, data)).to.be.revertedWithCustomError(f.wallet, "ZeroAddress");
    const id = await submit(f.wallet, f.a, f.stakingAddr, data);
    await expect(f.wallet.connect(f.outsider).confirm(id)).to.be.revertedWithCustomError(f.wallet, "NotOwner");
    await expect(f.wallet.connect(f.outsider).execute(id)).to.be.revertedWithCustomError(f.wallet, "NotOwner");
    await expect(f.wallet.connect(f.a).confirm(id)).to.be.revertedWithCustomError(f.wallet, "AlreadyConfirmed");
    await expect(f.wallet.connect(f.b).revoke(id)).to.be.revertedWithCustomError(f.wallet, "NotConfirmed");
    await expect(f.wallet.connect(f.a).confirm(99)).to.be.revertedWithCustomError(f.wallet, "TxNotFound");
  });

  it("revoked confirmations no longer count", async function () {
    const f = await loadFixture(deploy);
    const id = await submit(f.wallet, f.a, f.stakingAddr, f.staking.interface.encodeFunctionData("pause"));
    await f.wallet.connect(f.b).confirm(id);
    await f.wallet.connect(f.b).revoke(id);
    expect(await f.wallet.isConfirmed(id, f.b.address)).to.equal(false);
    await expect(f.wallet.connect(f.a).execute(id)).to.be.revertedWithCustomError(f.wallet, "NotEnoughConfirmations");
  });

  it("bubbles up the target's revert reason and allows a retry", async function () {
    const f = await loadFixture(deploy);
    // fundRewards without an approval fails inside the token
    const id = await submit(f.wallet, f.a, f.stakingAddr, f.staking.interface.encodeFunctionData("fundRewards", [U(1)]));
    await f.wallet.connect(f.b).confirm(id);
    await expect(f.wallet.connect(f.a).execute(id)).to.be.revertedWithCustomError(f.usdt, "ERC20InsufficientAllowance");
    expect((await f.wallet.getTransaction(id)).executed).to.equal(false);

    await run(f, await f.usdt.getAddress(), f.usdt.interface.encodeFunctionData("approve", [f.stakingAddr, U(1)]));
    await expect(f.wallet.connect(f.a).execute(id)).to.emit(f.staking, "RewardsFunded");
  });

  it("enforces the execution delay", async function () {
    const [a, b] = await ethers.getSigners();
    const W = await ethers.getContractFactory("MultiSigWallet");
    const w = await W.deploy([a.address, b.address], 2, 2 * DAY);
    await a.sendTransaction({ to: await w.getAddress(), value: U(1) });
    await w.connect(a).submit(b.address, U(1), "0x");
    await w.connect(b).confirm(0);
    await expect(w.connect(a).execute(0)).to.be.revertedWithCustomError(w, "DelayNotElapsed");
    await time.increase(2 * DAY);
    await expect(w.connect(a).execute(0)).to.changeEtherBalance(b, U(1));
  });

  it("manages owners, threshold and delay only through itself", async function () {
    const f = await loadFixture(deploy);
    const { wallet, a, b, c, outsider } = f;
    await expect(wallet.connect(a).addOwner(outsider.address)).to.be.revertedWithCustomError(wallet, "NotSelf");
    await expect(wallet.connect(a).changeThreshold(1)).to.be.revertedWithCustomError(wallet, "NotSelf");

    await run(f, f.walletAddr, selfCall(wallet, "addOwner", [outsider.address]));
    expect(await wallet.isOwner(outsider.address)).to.equal(true);
    await run(f, f.walletAddr, selfCall(wallet, "changeDelay", [DAY]));
    expect(await wallet.delay()).to.equal(DAY);
    // the delay now applies to the threshold change too
    const t = await submit(wallet, a, f.walletAddr, selfCall(wallet, "changeThreshold", [3]));
    await wallet.connect(b).confirm(t);
    await expect(wallet.connect(a).execute(t)).to.be.revertedWithCustomError(wallet, "DelayNotElapsed");
    await time.increase(DAY);
    await wallet.connect(a).execute(t);
    expect(await wallet.threshold()).to.equal(3);

    // 3-of-4 now, with a 1-day delay
    const id = await submit(wallet, a, f.walletAddr, selfCall(wallet, "replaceOwner", [c.address, ethers.Wallet.createRandom().address]));
    await wallet.connect(b).confirm(id);
    await wallet.connect(outsider).confirm(id);
    await time.increase(DAY);
    await wallet.connect(a).execute(id);
    expect(await wallet.isOwner(c.address)).to.equal(false);
    expect((await wallet.getOwners()).length).to.equal(4);
  });

  it("cannot remove an owner below the threshold", async function () {
    const f = await loadFixture(deploy);
    await run(f, f.walletAddr, selfCall(f.wallet, "changeThreshold", [3]));
    const id = await submit(f.wallet, f.a, f.walletAddr, selfCall(f.wallet, "removeOwner", [f.c.address]));
    await f.wallet.connect(f.b).confirm(id);
    await f.wallet.connect(f.c).confirm(id);
    await expect(f.wallet.connect(f.a).execute(id)).to.be.revertedWithCustomError(f.wallet, "InvalidThreshold");
  });

  it("drops a removed owner's confirmations, even if they are re-added", async function () {
    const f = await loadFixture(deploy);
    const { wallet, a, b, c } = f;
    const id = await submit(wallet, c, f.stakingAddr, f.staking.interface.encodeFunctionData("pause"));
    expect(await wallet.confirmationCount(id)).to.equal(1);

    await run(f, f.walletAddr, selfCall(wallet, "removeOwner", [c.address]));
    expect(await wallet.confirmationCount(id)).to.equal(0);
    await run(f, f.walletAddr, selfCall(wallet, "addOwner", [c.address]));
    expect(await wallet.confirmationCount(id)).to.equal(0);
    expect(await wallet.isConfirmed(id, c.address)).to.equal(false);

    await wallet.connect(a).confirm(id);
    await expect(wallet.connect(a).execute(id)).to.be.revertedWithCustomError(wallet, "NotEnoughConfirmations");
    await wallet.connect(b).confirm(id);
    await wallet.connect(a).execute(id);
    expect(await f.staking.paused()).to.equal(true);
  });
});
