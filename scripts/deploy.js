const { ethers } = require("hardhat");

// BEP20 USDT on BNB Smart Chain mainnet (18 decimals)
const BSC_USDT = "0x55d398326f99059fF775485246999027B3197955";

// Either use an existing multisig (MULTISIG_ADDRESS), or deploy a new MultiSigWallet
// from MULTISIG_OWNERS (comma-separated), MULTISIG_THRESHOLD and MULTISIG_DELAY (seconds, default 0).
async function getMultisig() {
  const existing = process.env.MULTISIG_ADDRESS;
  if (existing) {
    if (!ethers.isAddress(existing)) throw new Error("MULTISIG_ADDRESS is not a valid address");
    if ((await ethers.provider.getCode(existing)) === "0x") {
      throw new Error("MULTISIG_ADDRESS has no contract code; it must be a multisig, not a regular wallet");
    }
    return existing;
  }

  const owners = (process.env.MULTISIG_OWNERS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const threshold = Number(process.env.MULTISIG_THRESHOLD);
  const delay = Number(process.env.MULTISIG_DELAY || 0);
  if (owners.length === 0) {
    throw new Error("Set MULTISIG_ADDRESS, or MULTISIG_OWNERS as comma-separated addresses");
  }
  const bad = owners.filter((o) => !ethers.isAddress(o));
  if (bad.length) throw new Error(`Invalid owner address (check for typos / checksum): ${bad.join(", ")}`);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > owners.length) {
    throw new Error(`MULTISIG_THRESHOLD must be between 1 and ${owners.length}`);
  }
  if (owners.length > 1 && threshold < 2) {
    throw new Error("MULTISIG_THRESHOLD of 1 makes every owner a single point of failure");
  }

  const Wallet = await ethers.getContractFactory("MultiSigWallet");
  const wallet = await Wallet.deploy(owners, threshold, delay);
  await wallet.waitForDeployment();
  const addr = await wallet.getAddress();
  console.log("MultiSigWallet deployed to:", addr);
  console.log(`  owners (${threshold}-of-${owners.length}):`, owners.join(", "));
  console.log("  execution delay:", delay, "seconds");
  return addr;
}

async function main() {
  const multisig = await getMultisig();
  const Staking = await ethers.getContractFactory("USDTStaking");
  const staking = await Staking.deploy(BSC_USDT, multisig);
  await staking.waitForDeployment();
  console.log("USDTStaking deployed to:", await staking.getAddress());
  console.log("Owner (multisig):", multisig);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
