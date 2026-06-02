const { ethers } = require("hardhat");

async function main() {
    const [deployer, heir, hospital, government, legal] = await ethers.getSigners();

    console.log("LegacyChain v2 deployment");
    console.log(`Deployer:  ${deployer.address}`);
    console.log(`Heir:      ${heir.address}`);

    const OracleRegistry = await ethers.getContractFactory("OracleRegistry");
    const oracle = await OracleRegistry.deploy();
    await oracle.waitForDeployment();
    const oracleAddress = await oracle.getAddress();

    await oracle.addAuthority(hospital.address, ethers.encodeBytes32String("HOSPITAL"), "Hospital Authority");
    await oracle.addAuthority(government.address, ethers.encodeBytes32String("GOVERNMENT"), "Civil Registry Authority");
    await oracle.addAuthority(legal.address, ethers.encodeBytes32String("LEGAL"), "Legal Representative");

    const VaultFactory = await ethers.getContractFactory("VaultFactory");
    const factory = await VaultFactory.deploy(oracleAddress);
    await factory.waitForDeployment();
    const factoryAddress = await factory.getAddress();

    await oracle.setFactory(factoryAddress, true);

    const createTx = await factory.createVault(heir.address, 30 * 24 * 60 * 60);
    await createTx.wait();
    const vaults = await factory.getVaults(deployer.address);
    const vaultAddress = vaults[vaults.length - 1];

    await deployer.sendTransaction({
        to: vaultAddress,
        value: ethers.parseEther("1"),
    });

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy();
    await token.waitForDeployment();
    const tokenAddress = await token.getAddress();

    console.log("");
    console.log("Deployment complete");
    console.log(`ORACLE_ADDRESS=${oracleAddress}`);
    console.log(`VAULT_FACTORY_ADDRESS=${factoryAddress}`);
    console.log(`INHERITANCE_ADDRESS=${vaultAddress}`);
    console.log(`TOKEN_ADDRESS=${tokenAddress}`);
    console.log("");
    console.log("Frontend setup");
    console.log(`1. Open index.html and connect wallet ${deployer.address}`);
    console.log(`2. Click Create Vault and enter factory address: ${factoryAddress}`);
    console.log(`3. Or set localStorage manually: localStorage.setItem("legacychainActiveVaultAddress", "${vaultAddress}")`);
    console.log("");
    console.log("Backend setup");
    console.log(`ORACLE_ADDRESS=${oracleAddress}`);
    console.log(`INHERITANCE_ADDRESS=${vaultAddress}`);
    console.log(`AUTHORITY_HOSPITAL_PRIVATE_KEY=<private key for ${hospital.address}>`);
    console.log(`AUTHORITY_GOVERNMENT_PRIVATE_KEY=<private key for ${government.address}>`);
    console.log(`AUTHORITY_LEGAL_PRIVATE_KEY=<private key for ${legal.address}>`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
