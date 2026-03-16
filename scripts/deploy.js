const hre = require("hardhat");

async function main() {
  const [owner, heir, juror] = await hre.ethers.getSigners();

  console.log("------------------------------------------------");
  console.log("🚀 Deploying D-DADS Enterprise V5...");
  console.log("👤 Owner:", owner.address);
  console.log("👤 Heir:", heir.address);
  console.log("⚖️ Juror:", juror.address);

  // 120 saniye (2 dakika) süre limiti ile başlatıyoruz
  const Inheritance = await hre.ethers.getContractFactory("InheritanceSystem");
  const contract = await Inheritance.deploy(heir.address, juror.address, 120);

  await contract.waitForDeployment();

  console.log("✅ CONTRACT DEPLOYED!");
  console.log("📄 Address:", await contract.getAddress());
  console.log("------------------------------------------------");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});