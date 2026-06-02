const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("LegacyChain: Multi-Sig & Emergency Module Tests", function () {
    let MultiHeirInheritance, DecentralizedOracle;
    let contract, oracle;
    let owner, heir1, heir2, nonSigner, auth1, auth2;
    const TIME_LIMIT = 30 * 24 * 3600; // 30 days

    beforeEach(async function () {
        [owner, heir1, heir2, nonSigner, auth1, auth2] = await ethers.getSigners();

        // Deploy Mock Oracle
        DecentralizedOracle = await ethers.getContractFactory("contracts/DecentralizedOracle.sol:DecentralizedOracle");
        oracle = await DecentralizedOracle.deploy();

        await oracle.addAuthority(auth1.address);
        await oracle.addAuthority(auth2.address);

        // Deploy MultiHeirInheritance
        MultiHeirInheritance = await ethers.getContractFactory("MultiHeirInheritance");
        contract = await MultiHeirInheritance.deploy(
            heir1.address,
            oracle.target,
            TIME_LIMIT
        );

        // Note: constructor automatically adds: owner, oracle, and heir1 (initialHeir) to trustedSigners!
        // Let's verify this in the test
    });

    describe("1. Trusted Signers Setup", function () {
        it("Should initialize trustedSigners with owner, oracle, and initialHeir", async function () {
            expect(await contract.trustedSigners(0)).to.equal(owner.address);
            expect(await contract.trustedSigners(1)).to.equal(oracle.target);
            expect(await contract.trustedSigners(2)).to.equal(heir1.address);
            
            await expect(contract.trustedSigners(3)).to.be.reverted;
        });
    });

    describe("2. Emergency Approvals", function () {
        let actionHash;
        const targetAddress = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
        const transferAmount = ethers.parseEther("0.5");

        beforeEach(async function () {
            // Generate action hash for transfer
            const currentBlock = await ethers.provider.getBlockNumber();
            const blockPeriod = Math.floor(currentBlock / 100);
            actionHash = ethers.solidityPackedKeccak256(
                ["address", "uint256", "uint256"],
                [targetAddress, transferAmount, blockPeriod]
            );
        });

        it("Should allow a trusted signer to approve an emergency action", async function () {
            await expect(contract.connect(owner).approveEmergencyAction(actionHash))
                .to.emit(contract, "EmergencyApprovalGiven")
                .withArgs(owner.address, actionHash);

            expect(await contract.emergencyApprovals(actionHash)).to.equal(1);
            expect(await contract.hasApproved(actionHash, owner.address)).to.be.true;
        });

        it("Should revert if a non-trusted signer tries to approve", async function () {
            await expect(
                contract.connect(nonSigner).approveEmergencyAction(actionHash)
            ).to.be.revertedWith("Yetkisiz imzalayici");
        });

        it("Should revert if a trusted signer tries to approve the same action twice", async function () {
            await contract.connect(owner).approveEmergencyAction(actionHash);

            await expect(
                contract.connect(owner).approveEmergencyAction(actionHash)
            ).to.be.revertedWith("Zaten onayladiniz");
        });
    });

    describe("3. Emergency Multi-Sig Transfers", function () {
        let actionHash;
        const targetAddress = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
        const transferAmount = ethers.parseEther("0.5");

        beforeEach(async function () {
            // Deposit ETH to contract
            await owner.sendTransaction({
                to: contract.target,
                value: ethers.parseEther("1.0")
            });

            // Generate action hash for transfer
            const currentBlock = await ethers.provider.getBlockNumber();
            const blockPeriod = Math.floor(currentBlock / 100);
            actionHash = ethers.solidityPackedKeccak256(
                ["address", "uint256", "uint256"],
                [targetAddress, transferAmount, blockPeriod]
            );
        });

        it("Should allow emergency transfer when required signatures (2) are met", async function () {
            // Owner approves (1)
            await contract.connect(owner).approveEmergencyAction(actionHash);
            
            // heir1 (trusted signer) approves (2)
            await contract.connect(heir1).approveEmergencyAction(actionHash);

            // Execute transfer (called by a trusted signer - e.g., owner)
            const targetBalanceBefore = await ethers.provider.getBalance(targetAddress);
            await contract.connect(owner).emergencyMultiSigTransfer(targetAddress, transferAmount);
            const targetBalanceAfter = await ethers.provider.getBalance(targetAddress);

            expect(targetBalanceAfter - targetBalanceBefore).to.equal(transferAmount);
        });

        it("Should revert emergency transfer if called by a non-trusted signer", async function () {
            await contract.connect(owner).approveEmergencyAction(actionHash);
            await contract.connect(heir1).approveEmergencyAction(actionHash);

            await expect(
                contract.connect(nonSigner).emergencyMultiSigTransfer(targetAddress, transferAmount)
            ).to.be.revertedWith("Yetkisiz imzalayici");
        });

        it("Should revert emergency transfer if required signatures are not met", async function () {
            // Only owner approves (1)
            await contract.connect(owner).approveEmergencyAction(actionHash);

            await expect(
                contract.connect(owner).emergencyMultiSigTransfer(targetAddress, transferAmount)
            ).to.be.revertedWith("Yetersiz onay");
        });
    });

    describe("4. Timelock Duration Management", function () {
        it("Should allow owner to update timelock duration", async function () {
            const newDuration = 2 * 60; // 2 minutes
            await contract.connect(owner).setTimelockDuration(newDuration);
            
            expect(await contract.timelockDuration()).to.equal(newDuration);
        });

        it("Should restrict updating timelock duration to owner only", async function () {
            await expect(
                contract.connect(heir1).setTimelockDuration(2 * 60)
            ).to.be.revertedWith("Sadece sahip bu islemi yapabilir");
        });

        it("Should revert if the new timelock duration is less than the minimum (1 minute)", async function () {
            await expect(
                contract.connect(owner).setTimelockDuration(30) // 30 seconds
            ).to.be.revertedWith("Minimum 60 saniye olmali");
        });
    });
});
