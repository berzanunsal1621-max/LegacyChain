const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("DecentralizedOracle: Extended Tests", function () {
    let DecentralizedOracle;
    let oracle;
    let owner, auth1, auth2, auth3, nonAuth;

    beforeEach(async function () {
        [owner, auth1, auth2, auth3, nonAuth] = await ethers.getSigners();

        DecentralizedOracle = await ethers.getContractFactory("contracts/DecentralizedOracle.sol:DecentralizedOracle");
        oracle = await DecentralizedOracle.deploy();
    });

    describe("1. Authority Management", function () {
        it("Should allow owner to add an authority", async function () {
            await expect(oracle.connect(owner).addAuthority(auth1.address))
                .to.emit(oracle, "AuthorityAdded")
                .withArgs(auth1.address);

            expect(await oracle.isAuthority(auth1.address)).to.be.true;
            const authorities = await oracle.getAuthorities();
            expect(authorities).to.include(auth1.address);
        });

        it("Should revert if non-owner tries to add an authority", async function () {
            await expect(
                oracle.connect(nonAuth).addAuthority(auth1.address)
            ).to.be.revertedWith("Only owner can call this");
        });

        it("Should revert if adding a zero address as authority", async function () {
            await expect(
                oracle.connect(owner).addAuthority(ethers.ZeroAddress)
            ).to.be.revertedWith("Invalid address");
        });

        it("Should revert when adding a duplicate authority", async function () {
            await oracle.connect(owner).addAuthority(auth1.address);
            await expect(
                oracle.connect(owner).addAuthority(auth1.address)
            ).to.be.revertedWith("Already an authority");
        });

        it("Should allow owner to remove an authority", async function () {
            await oracle.connect(owner).addAuthority(auth1.address);
            await oracle.connect(owner).addAuthority(auth2.address);

            await expect(oracle.connect(owner).removeAuthority(auth1.address))
                .to.emit(oracle, "AuthorityRemoved")
                .withArgs(auth1.address);

            expect(await oracle.isAuthority(auth1.address)).to.be.false;
            const authorities = await oracle.getAuthorities();
            expect(authorities).to.not.include(auth1.address);
            expect(authorities).to.include(auth2.address);
        });

        it("Should revert if non-owner tries to remove an authority", async function () {
            await oracle.connect(owner).addAuthority(auth1.address);
            await expect(
                oracle.connect(nonAuth).removeAuthority(auth1.address)
            ).to.be.revertedWith("Only owner can call this");
        });

        it("Should revert when removing an address that is not an authority", async function () {
            await expect(
                oracle.connect(owner).removeAuthority(auth1.address)
            ).to.be.revertedWith("Not an authority");
        });
    });

    describe("2. Signal Submission & Consensus", function () {
        beforeEach(async function () {
            await oracle.connect(owner).addAuthority(auth1.address);
            await oracle.connect(owner).addAuthority(auth2.address);
        });

        it("Should not allow duplicate signals from the same authority", async function () {
            await oracle.connect(auth1).submitDeathSignal(nonAuth.address);
            await expect(
                oracle.connect(auth1).submitDeathSignal(nonAuth.address)
            ).to.be.revertedWith("Already submitted signal for this user");
        });

        it("Should confirm death and emit DeathConfirmed when consensus threshold met", async function () {
            await expect(oracle.connect(auth1).submitDeathSignal(nonAuth.address))
                .to.emit(oracle, "DeathSignalSubmitted")
                .withArgs(nonAuth.address, auth1.address);

            expect(await oracle.isDeathConfirmed(nonAuth.address)).to.be.false;

            await expect(oracle.connect(auth2).submitDeathSignal(nonAuth.address))
                .to.emit(oracle, "DeathConfirmed")
                .withArgs(nonAuth.address, any => typeof any === "bigint" || typeof any === "number");

            expect(await oracle.isDeathConfirmed(nonAuth.address)).to.be.true;
        });

        it("Should revert if a non-authority tries to submit a death signal", async function () {
            await expect(
                oracle.connect(nonAuth).submitDeathSignal(owner.address)
            ).to.be.revertedWith("Not an authorized oracle");
        });
    });

    describe("3. Reset Signals & Access Controls", function () {
        beforeEach(async function () {
            await oracle.connect(owner).addAuthority(auth1.address);
            await oracle.connect(owner).addAuthority(auth2.address);
            await oracle.connect(auth1).submitDeathSignal(nonAuth.address);
        });

        it("Should allow owner to reset signals", async function () {
            expect(await oracle.signalCount(nonAuth.address)).to.equal(1);
            await oracle.connect(owner).resetSignals(nonAuth.address);
            expect(await oracle.signalCount(nonAuth.address)).to.equal(0);
            expect(await oracle.deathSignals(nonAuth.address, auth1.address)).to.be.false;
        });

        it("Should allow registered inheritance contract to reset signals", async function () {
            // Register auth3 as the inheritance contract mock for testing reset authorization
            await oracle.connect(owner).setInheritanceContract(auth3.address);
            await oracle.connect(auth3).resetSignals(nonAuth.address);
            expect(await oracle.signalCount(nonAuth.address)).to.equal(0);
        });

        it("Should revert if unauthorized address tries to reset signals", async function () {
            await expect(
                oracle.connect(nonAuth).resetSignals(nonAuth.address)
            ).to.be.revertedWith("Only inheritance contract, owner, or registered vault can reset");
        });

        it("Should revert if setting zero address as inheritance contract", async function () {
            await expect(
                oracle.connect(owner).setInheritanceContract(ethers.ZeroAddress)
            ).to.be.revertedWith("Invalid address");
        });
    });
});
