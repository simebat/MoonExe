const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const U = (n) => ethers.parseUnits(String(n), 18);
const LOCK = 90 * 24 * 60 * 60;

describe("USDTStaking", function () {
  async function deploy() {
    const [owner, alice, bob, other] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const usdt = await Token.deploy("Tether USD", "USDT");
    const stray = await Token.deploy("Stray", "STRAY");
    const Staking = await ethers.getContractFactory("USDTStaking");
    const staking = await Staking.deploy(await usdt.getAddress(), owner.address);
    const addr = await staking.getAddress();

    for (const s of [owner, alice, bob]) {
      await usdt.mint(s.address, U(1_000_000));
      await usdt.connect(s).approve(addr, ethers.MaxUint256);
    }
    return { staking, usdt, stray, owner, alice, bob, other, addr };
  }

  async function funded() {
    const f = await deploy();
    await f.staking.fundRewards(U(1_000));
    return f;
  }

  it("computes 12% APR over 90 days", async function () {
    const { staking } = await loadFixture(deploy);
    // 1000 * 0.12 * 90 / 365 = 29.589041...
    expect(await staking.calculateReward(U(1000))).to.equal((U(1000) * 1200n * 90n) / (10000n * 365n));
  });

  it("rejects deposits without reward reserve", async function () {
    const { staking, alice } = await loadFixture(deploy);
    await expect(staking.connect(alice).stake(U(100))).to.be.revertedWithCustomError(staking, "InsufficientRewardReserve");
  });

  it("enforces minimum and one open position", async function () {
    const { staking, alice } = await loadFixture(funded);
    await expect(staking.connect(alice).stake(U(99))).to.be.revertedWithCustomError(staking, "BelowMinimum");
    await staking.connect(alice).stake(U(100));
    await expect(staking.connect(alice).stake(U(100))).to.be.revertedWithCustomError(staking, "PositionAlreadyOpen");
  });

  it("reserves reward and rejects once reserve is exhausted", async function () {
    const { staking, alice, bob } = await loadFixture(funded);
    const reward = await staking.calculateReward(U(30_000));
    await staking.connect(alice).stake(U(30_000));
    expect(await staking.totalReservedRewards()).to.equal(reward);
    expect(await staking.availableRewards()).to.equal(U(1_000) - reward);
    await expect(staking.connect(bob).stake(U(10_000))).to.be.revertedWithCustomError(staking, "InsufficientRewardReserve");
  });

  it("blocks early withdrawal and pays principal + reward once at maturity", async function () {
    const { staking, usdt, alice } = await loadFixture(funded);
    await staking.connect(alice).stake(U(1000));
    const reward = await staking.calculateReward(U(1000));
    await expect(staking.connect(alice).withdraw()).to.be.revertedWithCustomError(staking, "NotMatured");

    await time.increase(LOCK + 365 * 24 * 3600); // waiting longer earns nothing extra
    await expect(staking.connect(alice).withdraw()).to.changeTokenBalance(usdt, alice, U(1000) + reward);
    await expect(staking.connect(alice).withdraw()).to.be.revertedWithCustomError(staking, "NoOpenPosition");
    expect(await staking.totalPrincipal()).to.equal(0);
    expect(await staking.totalReservedRewards()).to.equal(0);
  });

  it("pause blocks new deposits but not matured withdrawals", async function () {
    const { staking, alice, bob } = await loadFixture(funded);
    await staking.connect(alice).stake(U(1000));
    await staking.pause();
    await expect(staking.connect(bob).stake(U(1000))).to.be.revertedWithCustomError(staking, "EnforcedPause");
    await time.increase(LOCK);
    await expect(staking.connect(alice).withdraw()).to.not.be.reverted;
  });

  it("owner can only withdraw unused rewards, never principal or reserved rewards", async function () {
    const { staking, usdt, owner, alice } = await loadFixture(funded);
    await staking.connect(alice).stake(U(10_000));
    const free = await staking.availableRewards();
    await expect(staking.withdrawUnusedRewards(owner.address, free + 1n)).to.be.revertedWithCustomError(
      staking,
      "InsufficientRewardReserve"
    );
    await staking.withdrawUnusedRewards(owner.address, free);
    expect(await staking.availableRewards()).to.equal(0);
    expect(await usdt.balanceOf(await staking.getAddress())).to.equal(
      (await staking.totalPrincipal()) + (await staking.totalReservedRewards())
    );
  });

  it("USDT sent directly by mistake is recoverable as unused", async function () {
    const { staking, usdt, owner, bob, addr } = await loadFixture(deploy);
    await usdt.connect(bob).transfer(addr, U(50));
    await expect(staking.withdrawUnusedRewards(bob.address, U(50))).to.changeTokenBalance(usdt, bob, U(50));
  });

  it("owner can rescue other tokens but not USDT", async function () {
    const { staking, usdt, stray, owner, addr } = await loadFixture(funded);
    await stray.mint(addr, U(5));
    await expect(staking.rescueToken(await stray.getAddress(), owner.address, U(5))).to.changeTokenBalance(stray, owner, U(5));
    await expect(staking.rescueToken(await usdt.getAddress(), owner.address, 1)).to.be.revertedWithCustomError(
      staking,
      "CannotRescueStakingToken"
    );
  });

  it("restricts admin functions and disables renounce", async function () {
    const { staking, other } = await loadFixture(funded);
    for (const call of [
      () => staking.connect(other).pause(),
      () => staking.connect(other).fundRewards(1),
      () => staking.connect(other).withdrawUnusedRewards(other.address, 1),
      () => staking.connect(other).rescueToken(other.address, other.address, 1),
      () => staking.connect(other).rescueNative(other.address),
    ]) {
      await expect(call()).to.be.revertedWithCustomError(staking, "OwnableUnauthorizedAccount");
    }
    await expect(staking.renounceOwnership()).to.be.revertedWithCustomError(staking, "RenounceDisabled");
  });

  it("rejects zero addresses and zero amounts", async function () {
    const { staking, usdt, owner } = await loadFixture(funded);
    const Staking = await ethers.getContractFactory("USDTStaking");
    await expect(Staking.deploy(ethers.ZeroAddress, owner.address)).to.be.revertedWithCustomError(staking, "ZeroAddress");
    await expect(Staking.deploy(await usdt.getAddress(), ethers.ZeroAddress)).to.be.revertedWithCustomError(
      staking,
      "OwnableInvalidOwner"
    );
    await expect(staking.fundRewards(0)).to.be.revertedWithCustomError(staking, "ZeroAmount");
    await expect(staking.withdrawUnusedRewards(ethers.ZeroAddress, 1)).to.be.revertedWithCustomError(staking, "ZeroAddress");
    await expect(staking.withdrawUnusedRewards(owner.address, 0)).to.be.revertedWithCustomError(staking, "ZeroAmount");
    await expect(staking.rescueToken(owner.address, ethers.ZeroAddress, 1)).to.be.revertedWithCustomError(staking, "ZeroAddress");
    await expect(staking.rescueNative(ethers.ZeroAddress)).to.be.revertedWithCustomError(staking, "ZeroAddress");
  });

  it("unpause re-opens deposits", async function () {
    const { staking, alice } = await loadFixture(funded);
    await staking.pause();
    await staking.unpause();
    await expect(staking.connect(alice).stake(U(100))).to.emit(staking, "Staked");
  });

  it("allows a new position after the previous one is withdrawn", async function () {
    const { staking, alice } = await loadFixture(funded);
    await staking.connect(alice).stake(U(100));
    await time.increase(LOCK);
    await staking.connect(alice).withdraw();
    await expect(staking.connect(alice).stake(U(100))).to.emit(staking, "Staked");
  });

  it("rejects a token that delivers less than the stated amount", async function () {
    const [owner, alice] = await ethers.getSigners();
    const Fee = await ethers.getContractFactory("FeeOnTransferToken");
    const fee = await Fee.deploy();
    const Staking = await ethers.getContractFactory("USDTStaking");
    const staking = await Staking.deploy(await fee.getAddress(), owner.address);
    const addr = await staking.getAddress();
    await fee.mint(addr, U(1_000)); // reward reserve
    await fee.mint(alice.address, U(1_000));
    await fee.connect(alice).approve(addr, ethers.MaxUint256);
    await expect(staking.connect(alice).stake(U(100))).to.be.revertedWithCustomError(staking, "UnexpectedTransferAmount");
  });

  it("rejects a staking token that does not have 18 decimals", async function () {
    const { staking, owner } = await loadFixture(deploy);
    const Dec = await ethers.getContractFactory("MockERC20Decimals");
    const Staking = await ethers.getContractFactory("USDTStaking");
    for (const d of [6, 20]) {
      const token = await Dec.deploy(d);
      await expect(Staking.deploy(await token.getAddress(), owner.address))
        .to.be.revertedWithCustomError(staking, "UnsupportedTokenDecimals")
        .withArgs(d);
    }
    const ok = await Dec.deploy(18);
    await expect(Staking.deploy(await ok.getAddress(), owner.address)).to.not.be.reverted;
    expect(await staking.MIN_DEPOSIT()).to.equal(U(100));
  });

  it("owner can rescue BNB held by the contract", async function () {
    const { staking, owner, other, addr } = await loadFixture(deploy);
    await ethers.provider.send("hardhat_setBalance", [addr, "0xDE0B6B3A7640000"]); // 1 BNB
    await expect(staking.rescueNative(other.address)).to.changeEtherBalance(other, U(1));
  });

  it("reverts BNB rescue when the receiver rejects it", async function () {
    const { staking, addr } = await loadFixture(deploy);
    await ethers.provider.send("hardhat_setBalance", [addr, "0xDE0B6B3A7640000"]);
    // the staking contract itself has no receive(), so it rejects BNB
    await expect(staking.rescueNative(addr)).to.be.revertedWithCustomError(staking, "NativeTransferFailed");
  });

  it("supports two-step ownership transfer", async function () {
    const { staking, other } = await loadFixture(deploy);
    await staking.transferOwnership(other.address);
    await staking.connect(other).acceptOwnership();
    expect(await staking.owner()).to.equal(other.address);
  });
});
