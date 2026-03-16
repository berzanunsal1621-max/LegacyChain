const { ethers } = require("hardhat");
const { expect } = require("chai");

describe("LegacyChain Advanced Protocol Verification", function () {
    let inheritance, oracle, token;
    let owner, heir, auth1, auth2, auth3, attacker;
    const TIME_LIMIT = 3600; // 1 hour
    const GRACE_PERIOD = 86400; // 24 hours (sync with contract)

    beforeEach(async function () {
        try {
            [owner, heir, auth1, auth2, auth3, attacker] = await ethers.getSigners();

            // 1. Deploy Decentralized Oracle
            const DecentralizedOracle = await ethers.getContractFactory("contracts/DecentralizedOracle.sol:DecentralizedOracle");
            oracle = await DecentralizedOracle.deploy();
            await oracle.waitForDeployment();

            // 2. Add Authorities to Oracle
            await oracle.addAuthority(auth1.address);
            await oracle.addAuthority(auth2.address);
            await oracle.addAuthority(auth3.address);

            // 3. Deploy MultiHeirInheritance
            const MultiHeirInheritance = await ethers.getContractFactory("contracts/MultiHeirInheritance.sol:MultiHeirInheritance");
            inheritance = await MultiHeirInheritance.deploy(heir.address, await oracle.getAddress(), TIME_LIMIT);
            await inheritance.waitForDeployment();

            // 4. Deploy Mock Token
            const MockERC20 = await ethers.getContractFactory("contracts/MockERC20.sol:MockERC20");
            token = await MockERC20.deploy();
            await token.waitForDeployment();

            // 5. Fund inheritance contract
            await owner.sendTransaction({
                to: await inheritance.getAddress(),
                value: ethers.parseEther("10")
            });
            await token.transfer(await inheritance.getAddress(), ethers.parseUnits("1000", 18));
        } catch (e) {
            console.error("DEBUG ERR:", e);
            throw e;
        }
    });

    describe("1. Decentralized Oracle Consensus", function () {
        it("Should not confirm death with only 1 signal", async function () {
            await oracle.connect(auth1).submitDeathSignal(owner.address);
            expect(await oracle.isDeathConfirmed(owner.address)).to.be.false;
            expect(await inheritance.timeLeft()).to.be.gt(0);
        });

        it("Should confirm death with 2/3 signals", async function () {
            await oracle.connect(auth1).submitDeathSignal(owner.address);
            await oracle.connect(auth2).submitDeathSignal(owner.address);
            expect(await oracle.isDeathConfirmed(owner.address)).to.be.true;
            expect(await inheritance.timeLeft()).to.equal(0);
        });
    });

    describe("2. Passive Heartbeat (Ghost Ping)", function () {
        it("Should reset timer and oracle signals on owner activity", async function () {
            // Simulate 1 signal
            await oracle.connect(auth1).submitDeathSignal(owner.address);
            expect(await oracle.signalCount(owner.address)).to.equal(1);

            // Increase time
            await ethers.provider.send("evm_increaseTime", [1800]);
            await ethers.provider.send("evm_mine");

            // Owner performs on-chain action
            await inheritance.connect(owner).recordActivity();

            // Verify reset
            expect(await oracle.signalCount(owner.address)).to.equal(0);
            expect(await inheritance.timeLeft()).to.be.closeTo(TIME_LIMIT, 5);
        });
    });

    describe("3. Grace Period Safety Net", function () {
        it("Should block claim during the 24h grace period", async function () {
            // Confirm death
            await oracle.connect(auth1).submitDeathSignal(owner.address);
            await oracle.connect(auth2).submitDeathSignal(owner.address);

            // Start grace period
            await inheritance.connect(heir).startGracePeriod();

            // Try to claim immediately
            await expect(inheritance.connect(heir).claimInheritance())
                .to.be.revertedWith("Grace Period: 24 saatlik guvenlik suresi dolmadi");
        });

        it("Should allow claim after 24h grace period", async function () {
            await oracle.connect(auth1).submitDeathSignal(owner.address);
            await oracle.connect(auth2).submitDeathSignal(owner.address);

            // Start grace period
            await inheritance.connect(heir).startGracePeriod();

            // Advance 25 hours
            await ethers.provider.send("evm_increaseTime", [GRACE_PERIOD + 3600]);
            await ethers.provider.send("evm_mine");

            await expect(inheritance.connect(heir).claimInheritance()).to.not.be.reverted;
        });

        it("Should allow owner to cancel inheritance during grace period", async function () {
            await oracle.connect(auth1).submitDeathSignal(owner.address);
            await oracle.connect(auth2).submitDeathSignal(owner.address);

            // Owner proves they are alive
            await inheritance.connect(owner).recordActivity();

            // Verify protocol is reset
            expect(await oracle.isDeathConfirmed(owner.address)).to.be.false;
            expect(await inheritance.timeLeft()).to.be.gt(0);
        });
    });

    describe("4. Multi-Asset Claim", function () {
        it("Should transfer ERC20 tokens after grace period", async function () {
            await oracle.connect(auth1).submitDeathSignal(owner.address);
            await oracle.connect(auth2).submitDeathSignal(owner.address);

            // Start grace period
            await inheritance.connect(heir).startGracePeriod();

            await ethers.provider.send("evm_increaseTime", [GRACE_PERIOD + 3600]);
            await ethers.provider.send("evm_mine");

            const beforeBal = await token.balanceOf(heir.address);
            await inheritance.connect(heir).claimTokens(await token.getAddress());
            const afterBal = await token.balanceOf(heir.address);

            expect(afterBal - beforeBal).to.equal(ethers.parseUnits("1000", 18));
        });
    });
});
