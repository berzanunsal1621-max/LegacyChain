const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("LegacyChain: Commit-Reveal Privacy Module Tests", function () {
    let MultiHeirInheritance, DecentralizedOracle;
    let contract, oracle;
    let owner, heir1, heir2, heir3, auth1, auth2;
    const TIME_LIMIT = 30 * 24 * 3600; // 30 days

    beforeEach(async function () {
        [owner, heir1, heir2, heir3, auth1, auth2] = await ethers.getSigners();

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
    });

    describe("1. Commit Phase (addHeirHash)", function () {
        it("Should allow owner to commit a hidden heir with a valid hash and percentage", async function () {
            const salt = "my-secret-salt";
            const hash = ethers.solidityPackedKeccak256(
                ["address", "string", "string"],
                [heir2.address, "Hidden Heir 2", salt]
            );

            // Add heir hash
            await expect(contract.connect(owner).addHeirHash(hash, 30))
                .to.emit(contract, "HeirAdded")
                .withArgs(ethers.ZeroAddress, 30, "Hidden Heir");

            // Verify heir struct added in heirs list
            const h = await contract.heirs(1);
            expect(h.wallet).to.equal(ethers.ZeroAddress);
            expect(h.percentage).to.equal(30);
            expect(h.name).to.equal("Hidden Heir");
            expect(h.isActive).to.be.true;
            expect(h.secretHash).to.equal(hash);
        });

        it("Should revert if a non-owner tries to commit an heir hash", async function () {
            const salt = "my-secret-salt";
            const hash = ethers.solidityPackedKeccak256(
                ["address", "string", "string"],
                [heir2.address, "Hidden Heir 2", salt]
            );

            await expect(
                contract.connect(heir1).addHeirHash(hash, 30)
            ).to.be.revertedWith("Sadece sahip bu islemi yapabilir");
        });

        it("Should revert if the committed percentage is 0 or 100", async function () {
            const hash = ethers.solidityPackedKeccak256(["string"], ["some-data"]);
            
            await expect(
                contract.connect(owner).addHeirHash(hash, 0)
            ).to.be.revertedWith("Yuzde 1-99 arasi olmali");

            await expect(
                contract.connect(owner).addHeirHash(hash, 100)
            ).to.be.revertedWith("Yuzde 1-99 arasi olmali");
        });

        it("Should revert if total percentage exceeds 100%", async function () {
            const hash1 = ethers.solidityPackedKeccak256(["string"], ["data1"]);
            const hash2 = ethers.solidityPackedKeccak256(["string"], ["data2"]);

            // Primary heir starts at 100% and auto-reduces when adding new heirs.
            // Let's add an heir with 60%
            await contract.addHeirHash(hash1, 60);
            
            // Try to add another heir with 50%. Since primary heir only has 40% left, it should revert with 'Birinci varisin yuzdesi yetersiz'
            await expect(
                contract.addHeirHash(hash2, 50)
            ).to.be.revertedWith("Birinci varisin yuzdesi yetersiz");
        });
    });

    describe("2. Reveal Phase (revealHeir)", function () {
        let hash;
        const name = "Hidden Heir 2";
        const percentage = 30;
        const salt = "my-secret-salt";

        beforeEach(async function () {
            hash = ethers.solidityPackedKeccak256(
                ["address", "string", "string"],
                [heir2.address, name, salt]
            );

            await contract.addHeirHash(hash, percentage);
        });

        it("Should allow anyone to reveal committed heir with correct parameters after owner death", async function () {
            // Must be dead
            await oracle.connect(auth1).submitDeathSignal(owner.address);
            await oracle.connect(auth2).submitDeathSignal(owner.address);

            // Reveal heir at index 1
            await expect(contract.connect(heir2).revealHeir(1, heir2.address, name, salt))
                .to.emit(contract, "HeirUpdated")
                .withArgs(1, heir2.address, percentage);

            const h = await contract.heirs(1);
            expect(h.wallet).to.equal(heir2.address);
            expect(h.name).to.equal(name);
            expect(h.secretHash).to.equal(hash);
        });

        it("Should revert if trying to reveal before death confirmation", async function () {
            // Owner is still alive
            await expect(
                contract.connect(heir2).revealHeir(1, heir2.address, name, salt)
            ).to.be.revertedWith("Olum onayi yok, reveal yapilamaz");
        });

        it("Should revert if correct salt is not provided", async function () {
            await oracle.connect(auth1).submitDeathSignal(owner.address);
            await oracle.connect(auth2).submitDeathSignal(owner.address);

            const wrongSalt = "wrong-salt";
            await expect(
                contract.connect(heir2).revealHeir(1, heir2.address, name, wrongSalt)
            ).to.be.revertedWith("Hatali bilgiler veya yanlis varis");
        });

        it("Should revert if correct address is not provided", async function () {
            await oracle.connect(auth1).submitDeathSignal(owner.address);
            await oracle.connect(auth2).submitDeathSignal(owner.address);

            // Wrong address
            await expect(
                contract.connect(heir2).revealHeir(1, heir3.address, name, salt)
            ).to.be.revertedWith("Hatali bilgiler veya yanlis varis");
        });

        it("Should revert if trying to reveal an already revealed heir", async function () {
            await oracle.connect(auth1).submitDeathSignal(owner.address);
            await oracle.connect(auth2).submitDeathSignal(owner.address);

            await contract.connect(heir2).revealHeir(1, heir2.address, name, salt);

            await expect(
                contract.connect(heir2).revealHeir(1, heir2.address, name, salt)
            ).to.be.revertedWith("Vasiyet zaten aciga cikarildi veya acik kaydedildi");
        });
    });
});
