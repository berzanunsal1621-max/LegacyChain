// ===========================================
// LegacyChain Security Test Suite
// ===========================================
// This file contains security test scenarios for the InheritanceSystem smart contract.
// Run these tests to verify access control and edge cases.

const { ethers } = require("hardhat");
const { expect } = require("chai");

describe("InheritanceSystem Security Tests", function () {
    let contract;
    let owner, heir, oracle, attacker;

    beforeEach(async function () {
        [owner, heir, oracle, attacker] = await ethers.getSigners();

        const InheritanceSystem = await ethers.getContractFactory("InheritanceSystem");
        contract = await InheritanceSystem.deploy(heir.address, oracle.address, 300);
        await contract.waitForDeployment();
    });

    // ===========================================
    // ACCESS CONTROL TESTS
    // ===========================================

    describe("Access Control", function () {

        it("Should allow only owner to call ping()", async function () {
            // Owner can ping
            await expect(contract.connect(owner).ping()).to.not.be.reverted;

            // Attacker cannot ping
            await expect(contract.connect(attacker).ping()).to.be.revertedWith("Yetkisiz");
        });

        it("Should allow only owner/oracle to call simulateOracleSignal()", async function () {
            // Owner can call
            await expect(contract.connect(owner).simulateOracleSignal()).to.not.be.reverted;

            // Reset for next test
            await contract.connect(owner).ping();

            // Oracle can call
            await expect(contract.connect(oracle).simulateOracleSignal()).to.not.be.reverted;

            // Attacker cannot call
            await expect(contract.connect(attacker).simulateOracleSignal())
                .to.be.revertedWith("Yetkisiz Oracle");
        });

        it("Should allow only owner to call emergencyWithdraw()", async function () {
            // Attacker cannot withdraw
            await expect(contract.connect(attacker).emergencyWithdraw())
                .to.be.revertedWith("Yetkisiz");

            // Heir cannot withdraw
            await expect(contract.connect(heir).emergencyWithdraw())
                .to.be.revertedWith("Yetkisiz");
        });
    });

    // ===========================================
    // TIMER LOGIC TESTS
    // ===========================================

    describe("Timer Logic", function () {

        it("Should return correct timeLeft after deployment", async function () {
            const timeLeft = await contract.timeLeft();
            expect(timeLeft).to.be.closeTo(300, 5); // Allow 5 second margin
        });

        it("Should reset timer after ping", async function () {
            // Wait some time
            await ethers.provider.send("evm_increaseTime", [100]);
            await ethers.provider.send("evm_mine");

            // Ping to reset
            await contract.connect(owner).ping();

            const timeLeft = await contract.timeLeft();
            expect(timeLeft).to.be.closeTo(300, 5);
        });

        it("Should return 0 after oracle signal", async function () {
            await contract.connect(oracle).simulateOracleSignal();

            const timeLeft = await contract.timeLeft();
            expect(timeLeft).to.equal(0);
        });

        it("Should return 0 after timer expires", async function () {
            // Fast forward time beyond timeLimit
            await ethers.provider.send("evm_increaseTime", [301]);
            await ethers.provider.send("evm_mine");

            const timeLeft = await contract.timeLeft();
            expect(timeLeft).to.equal(0);
        });
    });

    // ===========================================
    // INHERITANCE CLAIM TESTS
    // ===========================================

    describe("Inheritance Claim", function () {

        it("Should not allow claim before timer expires", async function () {
            await expect(contract.connect(heir).claimInheritance())
                .to.be.revertedWith("Sure dolmadi");
        });

        it("Should allow heir to claim after oracle signal", async function () {
            // Send some ETH to contract
            await owner.sendTransaction({
                to: await contract.getAddress(),
                value: ethers.parseEther("1.0")
            });

            // Trigger oracle
            await contract.connect(oracle).simulateOracleSignal();

            // Heir can now claim
            await expect(contract.connect(heir).claimInheritance()).to.not.be.reverted;
        });

        it("Should transfer all balance to heir", async function () {
            const depositAmount = ethers.parseEther("1.0");

            // Deposit ETH
            await owner.sendTransaction({
                to: await contract.getAddress(),
                value: depositAmount
            });

            // Trigger oracle
            await contract.connect(oracle).simulateOracleSignal();

            // Get heir balance before
            const heirBalanceBefore = await ethers.provider.getBalance(heir.address);

            // Claim inheritance
            const tx = await contract.connect(heir).claimInheritance();
            const receipt = await tx.wait();
            const gasUsed = receipt.gasUsed * receipt.gasPrice;

            // Get heir balance after
            const heirBalanceAfter = await ethers.provider.getBalance(heir.address);

            // Verify transfer (accounting for gas)
            expect(heirBalanceAfter).to.be.closeTo(
                heirBalanceBefore + depositAmount - gasUsed,
                ethers.parseEther("0.01")
            );
        });
    });

    // ===========================================
    // EDGE CASE TESTS
    // ===========================================

    describe("Edge Cases", function () {

        it("Should handle zero balance claim gracefully", async function () {
            // Trigger oracle
            await contract.connect(oracle).simulateOracleSignal();

            // Try to claim with zero balance
            await expect(contract.connect(heir).claimInheritance())
                .to.be.revertedWith("Bakiye yok");
        });

        it("Should emit correct events", async function () {
            // Test Pulse event
            await expect(contract.connect(owner).ping())
                .to.emit(contract, "Pulse");

            // Test OracleSignalReceived event
            await expect(contract.connect(oracle).simulateOracleSignal())
                .to.emit(contract, "OracleSignalReceived")
                .withArgs("Death Confirmed", await ethers.provider.getBlock("latest").then(b => b.timestamp + 1));
        });
    });
});

// ===========================================
// MANUAL TEST CHECKLIST
// ===========================================
/*
 * Run these tests manually in Remix or via Hardhat:
 * 
 * 1. ACCESS CONTROL
 *    [ ] Only owner can call ping()
 *    [ ] Only owner/oracle can call simulateOracleSignal()
 *    [ ] Only owner can call emergencyWithdraw()
 *    [ ] Anyone can call timeLeft() and currentBalance() (view functions)
 * 
 * 2. TIMER BEHAVIOR
 *    [ ] Timer starts at timeLimit after deployment
 *    [ ] Timer resets to timeLimit after ping()
 *    [ ] Timer becomes 0 after simulateOracleSignal()
 *    [ ] Timer becomes 0 after natural expiration
 * 
 * 3. ASSET TRANSFER
 *    [ ] Heir can claim only when timeLeft == 0
 *    [ ] All ETH is transferred to heir
 *    [ ] Contract balance becomes 0 after claim
 * 
 * 4. EVENTS
 *    [ ] Pulse emitted on ping()
 *    [ ] OracleSignalReceived emitted on simulateOracleSignal()
 *    [ ] AssetsTransferred emitted on claimInheritance()
 *    [ ] EmergencyWithdraw emitted on emergencyWithdraw()
 */
