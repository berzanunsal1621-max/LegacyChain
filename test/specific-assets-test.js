const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("LegacyChain: Specific Assets Module Tests", function () {
    let MultiHeirInheritance, DecentralizedOracle, MockERC20, MockERC721;
    let contract, oracle, token, nft;
    let owner, heir1, heir2, nonHeir, auth1, auth2;
    const TIME_LIMIT = 30 * 24 * 3600; // 30 days
    const GRACE_PERIOD = 24 * 3600; // 24 hours

    beforeEach(async function () {
        [owner, heir1, heir2, nonHeir, auth1, auth2] = await ethers.getSigners();

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

        // Deploy Mock ERC20 & NFT
        MockERC20 = await ethers.getContractFactory("MockERC20");
        token = await MockERC20.deploy();

        MockERC721 = await ethers.getContractFactory("MockERC721");
        nft = await MockERC721.deploy("Mock NFT", "MNFT");
    });

    async function triggerDeathAndWaitGrace() {
        await oracle.connect(auth1).submitDeathSignal(owner.address);
        await oracle.connect(auth2).submitDeathSignal(owner.address);
        await contract.connect(heir1).startGracePeriod();
        await ethers.provider.send("evm_increaseTime", [GRACE_PERIOD + 3600]);
        await ethers.provider.send("evm_mine");
    }

    describe("1. Specific Asset Assignment", function () {
        it("Should allow owner to assign specific ERC20 token to a heir", async function () {
            const amount = ethers.parseUnits("500", 18);
            await contract.assignSpecificToken(token.target, amount, heir2.address);
            
            expect(await contract.getSpecificWillsCount()).to.equal(1);
            
            const will = await contract.specificWills(0);
            expect(will.assetAddress).to.equal(token.target);
            expect(will.amount).to.equal(amount);
            expect(will.tokenId).to.equal(0);
            expect(will.designatedHeir).to.equal(heir2.address);
            expect(will.isERC721).to.be.false;
            expect(will.isClaimed).to.be.false;
        });

        it("Should allow owner to assign specific NFT to a heir", async function () {
            const tokenId = 42;
            await contract.assignSpecificNFT(nft.target, tokenId, heir1.address);
            
            expect(await contract.getSpecificWillsCount()).to.equal(1);
            
            const will = await contract.specificWills(0);
            expect(will.assetAddress).to.equal(nft.target);
            expect(will.amount).to.equal(1);
            expect(will.tokenId).to.equal(tokenId);
            expect(will.designatedHeir).to.equal(heir1.address);
            expect(will.isERC721).to.be.true;
            expect(will.isClaimed).to.be.false;
        });

        it("Should restrict assignment functions to owner only", async function () {
            const amount = ethers.parseUnits("500", 18);
            await expect(
                contract.connect(heir1).assignSpecificToken(token.target, amount, heir2.address)
            ).to.be.revertedWith("Sadece sahip bu islemi yapabilir");

            await expect(
                contract.connect(heir1).assignSpecificNFT(nft.target, 42, heir2.address)
            ).to.be.revertedWith("Sadece sahip bu islemi yapabilir");
        });

        it("Should revert on invalid addresses when assigning", async function () {
            const amount = ethers.parseUnits("500", 18);
            await expect(
                contract.assignSpecificToken(ethers.ZeroAddress, amount, heir2.address)
            ).to.be.revertedWith("Gecersiz adres");

            await expect(
                contract.assignSpecificToken(token.target, amount, ethers.ZeroAddress)
            ).to.be.revertedWith("Gecersiz varis");
        });
    });

    describe("2. Asset Removal", function () {
        beforeEach(async function () {
            await contract.assignSpecificToken(token.target, 1000, heir2.address);
            await contract.assignSpecificNFT(nft.target, 5, heir1.address);
        });

        it("Should allow owner to remove assigned asset", async function () {
            expect(await contract.getSpecificWillsCount()).to.equal(2);
            
            // Remove first asset
            await contract.removeSpecificAsset(0);
            
            expect(await contract.getSpecificWillsCount()).to.equal(2); // Length doesn't decrease, replaced by zero values
            const will = await contract.specificWills(0);
            expect(will.designatedHeir).to.equal(ethers.ZeroAddress);
            expect(will.amount).to.equal(0);
        });

        it("Should restrict asset removal to owner only", async function () {
            await expect(
                contract.connect(heir1).removeSpecificAsset(0)
            ).to.be.revertedWith("Sadece sahip bu islemi yapabilir");
        });

        it("Should revert when trying to remove an invalid index", async function () {
            await expect(
                contract.removeSpecificAsset(99)
            ).to.be.revertedWith("Gecersiz index");
        });
    });

    describe("3. Claiming Specific Assets", function () {
        const tokenId = 99;
        const amount = ethers.parseUnits("1000", 18);

        beforeEach(async function () {
            // Assign ERC20 & NFT
            await contract.assignSpecificToken(token.target, amount, heir2.address);
            await contract.assignSpecificNFT(nft.target, tokenId, heir1.address);

            // Fund owner (mint to owner)
            await token.mint(owner.address, amount);
            await nft.mint(owner.address, tokenId);
            
            // Approve contract to pull from owner
            await token.connect(owner).approve(contract.target, amount);
            await nft.connect(owner).approve(contract.target, tokenId);
        });

        it("Should allow designated heir to claim specific ERC20 token after grace period", async function () {
            await triggerDeathAndWaitGrace();

            const heirBalanceBefore = await token.balanceOf(heir2.address);
            await contract.connect(heir2).claimSpecificAsset(0);
            const heirBalanceAfter = await token.balanceOf(heir2.address);

            expect(heirBalanceAfter - heirBalanceBefore).to.equal(amount);
            
            const will = await contract.specificWills(0);
            expect(will.isClaimed).to.be.true;
        });

        it("Should allow designated heir to claim specific NFT after grace period", async function () {
            await triggerDeathAndWaitGrace();

            expect(await nft.ownerOf(tokenId)).to.equal(owner.address);
            await contract.connect(heir1).claimSpecificAsset(1);
            expect(await nft.ownerOf(tokenId)).to.equal(heir1.address);

            const will = await contract.specificWills(1);
            expect(will.isClaimed).to.be.true;
        });

        it("Should revert if claiming before death confirmation or grace period", async function () {
            // No death signal submitted yet
            await expect(
                contract.connect(heir2).claimSpecificAsset(0)
            ).to.be.revertedWith("Sure dolmadi veya Oracle onayi yok");
        });

        it("Should NOT allow non-heir to trigger claimSpecificAsset", async function () {
            await triggerDeathAndWaitGrace();

            await expect(
                contract.connect(nonHeir).claimSpecificAsset(0)
            ).to.be.revertedWith("Sadece atanmis varis talep edebilir");
        });

        it("Should revert on double claiming", async function () {
            await triggerDeathAndWaitGrace();

            await contract.connect(heir2).claimSpecificAsset(0);

            await expect(
                contract.connect(heir2).claimSpecificAsset(0)
            ).to.be.revertedWith("Zaten talep edildi");
        });
    });
});
