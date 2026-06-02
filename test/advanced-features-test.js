const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Advanced Inheritance Features (Specific Assets & Commit-Reveal)", function () {
    let inheritance, oracle, mockERC20, mockERC721;
    let owner, heir1, heir2, authority1, authority2;

    beforeEach(async function () {
        [owner, heir1, heir2, authority1, authority2] = await ethers.getSigners();

        // Deploy Oracle
        const Oracle = await ethers.getContractFactory("contracts/DecentralizedOracle.sol:DecentralizedOracle");
        oracle = await Oracle.deploy();
        
        await oracle.addAuthority(authority1.address);
        await oracle.addAuthority(authority2.address);

        // Deploy Inheritance
        const Inheritance = await ethers.getContractFactory("MultiHeirInheritance");
        // TimeLimit = 365 days
        inheritance = await Inheritance.deploy(heir1.address, await oracle.getAddress(), 31536000);

        // Register inheritance to oracle
        await oracle.setInheritanceContract(await inheritance.getAddress());

        // Deploy Mock Tokens
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        mockERC20 = await MockERC20.deploy();

        const MockERC721 = await ethers.getContractFactory("MockERC721");
        mockERC721 = await MockERC721.deploy("Mock NFT", "MNFT");
    });

    describe("Module 1: Specific Asset Allocation", function () {
        it("should allocate and claim specific NFT", async function () {
            // Mint NFT to owner
            await mockERC721.mint(owner.address, 1);
            
            // Assign NFT to heir2
            await inheritance.assignSpecificNFT(await mockERC721.getAddress(), 1, heir2.address);
            
            // Owner approves inheritance contract to spend NFT
            await mockERC721.approve(await inheritance.getAddress(), 1);

            // Confirm death
            await oracle.connect(authority1).submitDeathSignal(owner.address);
            await oracle.connect(authority2).submitDeathSignal(owner.address);
            await inheritance.startGracePeriod();

            // Fast forward Grace Period
            await time.increase(24 * 60 * 60 + 1);

            // Heir2 claims specific asset (index 0)
            await inheritance.connect(heir2).claimSpecificAsset(0);

            // Verify NFT transferred
            expect(await mockERC721.ownerOf(1)).to.equal(heir2.address);
        });
    });

    describe("Module 3: Commit-Reveal Privacy", function () {
        it("should commit hidden heir and reveal after death", async function () {
            const salt = "mySecretSalt123";
            const secretHash = ethers.solidityPackedKeccak256(
                ["address", "string", "string"],
                [heir2.address, "Hidden Heir Name", salt]
            );

            // Owner adds hidden heir (percentage 50%)
            await inheritance.addHeirHash(secretHash, 50);

            // Confirm death
            await oracle.connect(authority1).submitDeathSignal(owner.address);
            await oracle.connect(authority2).submitDeathSignal(owner.address);
            await inheritance.startGracePeriod();
            await time.increase(24 * 60 * 60 + 1);

            // Fund the contract first so it doesn't revert with "Bakiye yok"
            await owner.sendTransaction({ to: await inheritance.getAddress(), value: ethers.parseEther("1.0") });

            // Claim should revert before reveal
            await expect(inheritance.claimInheritance()).to.be.revertedWith("Once tum gizli vasiyetler aciga cikarilmali (Reveal)");

            // Reveal hidden heir (index 1, because index 0 is initial heir1)
            await inheritance.revealHeir(1, heir2.address, "Hidden Heir Name", salt);

            // Now claim should work
            await inheritance.claimInheritance();
            
            // Since there is no revert, test passed.
        });
    });
});
