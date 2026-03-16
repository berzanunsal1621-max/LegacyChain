// ===========================================
// MultiHeirInheritance - Gelişmiş Güvenlik Test Suite
// ===========================================
// Teknofest 2025 - LegacyChain Project
// Bu dosya çoklu varis sistemi için kapsamlı testler içerir.

const { ethers } = require("hardhat");
const { expect } = require("chai");

describe("MultiHeirInheritance Security Tests", function () {
    let contract;
    let owner, heir1, heir2, heir3, oracle, attacker;
    const TIME_LIMIT = 300; // 5 dakika

    beforeEach(async function () {
        [owner, heir1, heir2, heir3, oracle, attacker] = await ethers.getSigners();

        const MultiHeirInheritance = await ethers.getContractFactory("MultiHeirInheritance");
        contract = await MultiHeirInheritance.deploy(heir1.address, oracle.address, TIME_LIMIT);
        await contract.waitForDeployment();
    });

    // ===========================================
    // 1. ACCESS CONTROL TESTS
    // ===========================================

    describe("1. Access Control", function () {

        it("Should allow only owner to call ping()", async function () {
            await expect(contract.connect(owner).ping()).to.not.be.reverted;
            await expect(contract.connect(attacker).ping())
                .to.be.revertedWith("Sadece sahip bu islemi yapabilir");
        });

        it("Should allow only owner/oracle to call simulateOracleSignal()", async function () {
            await expect(contract.connect(owner).simulateOracleSignal()).to.not.be.reverted;

            // Reset
            await contract.connect(owner).ping();

            await expect(contract.connect(oracle).simulateOracleSignal()).to.not.be.reverted;

            await expect(contract.connect(attacker).simulateOracleSignal())
                .to.be.revertedWith("Yetkisiz Oracle");
        });

        it("Should allow only owner to call emergencyWithdraw()", async function () {
            // Deposit some ETH
            await owner.sendTransaction({
                to: await contract.getAddress(),
                value: ethers.parseEther("1.0")
            });

            await expect(contract.connect(attacker).emergencyWithdraw())
                .to.be.revertedWith("Sadece sahip bu islemi yapabilir");

            await expect(contract.connect(heir1).emergencyWithdraw())
                .to.be.revertedWith("Sadece sahip bu islemi yapabilir");
        });

        it("Should allow only owner to add heirs", async function () {
            await expect(contract.connect(attacker).addHeir(heir2.address, 20, "Attacker Heir"))
                .to.be.revertedWith("Sadece sahip bu islemi yapabilir");
        });
    });

    // ===========================================
    // 2. MULTI-HEIR MANAGEMENT TESTS
    // ===========================================

    describe("2. Multi-Heir Management", function () {

        it("Should initialize with primary heir at 100%", async function () {
            const heir = await contract.getHeir(0);
            expect(heir.wallet).to.equal(heir1.address);
            expect(heir.percentage).to.equal(100);
            expect(heir.isActive).to.be.true;
        });

        it("Should add multiple heirs correctly", async function () {
            // İlk varisin yüzdesini düşür
            await contract.initiateHeirUpdate(0, heir1.address, 50, "Primary Heir");
            await ethers.provider.send("evm_increaseTime", [86401]); // 24 saat + 1 saniye
            await ethers.provider.send("evm_mine");
            await contract.executeHeirUpdate(0);

            // Yeni varis ekle
            await contract.addHeir(heir2.address, 30, "Secondary Heir");
            await contract.addHeir(heir3.address, 20, "Tertiary Heir");

            expect(await contract.getHeirCount()).to.equal(3);
            expect(await contract.getTotalActivePercentage()).to.equal(100);
        });

        it("Should auto-reduce primary heir percentage when adding new heir", async function () {
            // İlk varis 100% → addHeir(30) → birinci %70, yeni %30
            await contract.addHeir(heir2.address, 30, "Test");
            const primaryHeir = await contract.getHeir(0);
            expect(primaryHeir.percentage).to.equal(70);
            const newHeir = await contract.getHeir(1);
            expect(newHeir.percentage).to.equal(30);
            expect(await contract.getTotalActivePercentage()).to.equal(100);
        });

        it("Should not exceed MAX_HEIRS limit", async function () {
            // Bu test MAX_HEIRS = 10 için
            const signers = await ethers.getSigners();

            // 9 varis daha ekle (toplam 10) - otomatik yüzde düşürme
            for (let i = 0; i < 9; i++) {
                await contract.addHeir(signers[i + 6].address, 10, `Heir ${i + 2}`);
            }

            expect(await contract.getHeirCount()).to.equal(10);

            // 11. varis eklenemez
            await expect(contract.addHeir(attacker.address, 1, "11th Heir"))
                .to.be.revertedWith("Maksimum varis sayisina ulasildi");
        });

        it("Should deactivate heir correctly", async function () {
            // Önce ikinci varis ekle
            await contract.initiateHeirUpdate(0, heir1.address, 50, "Primary");
            await ethers.provider.send("evm_increaseTime", [86401]);
            await ethers.provider.send("evm_mine");
            await contract.executeHeirUpdate(0);
            await contract.addHeir(heir2.address, 50, "Secondary");

            // İlk varisi deaktive et
            await contract.deactivateHeir(0);

            const heir = await contract.getHeir(0);
            expect(heir.isActive).to.be.false;
        });

        it("Should not allow deactivating last heir", async function () {
            await expect(contract.deactivateHeir(0))
                .to.be.revertedWith("En az bir varis olmali");
        });
    });

    // ===========================================
    // 3. TIMELOCK TESTS
    // ===========================================

    describe("3. TimeLock Mechanism", function () {

        it("Should initiate heir update with correct unlock time", async function () {
            await contract.initiateHeirUpdate(0, heir2.address, 80, "New Primary");

            const pending = await contract.getPendingChange(0);
            expect(pending.exists).to.be.true;
            expect(pending.newHeir).to.equal(heir2.address);
            expect(pending.newPercentage).to.equal(80);
        });

        it("Should not execute update before timelock expires", async function () {
            await contract.initiateHeirUpdate(0, heir2.address, 80, "New Primary");

            // Sadece 1 saat geç
            await ethers.provider.send("evm_increaseTime", [3600]);
            await ethers.provider.send("evm_mine");

            await expect(contract.executeHeirUpdate(0))
                .to.be.revertedWith("TimeLock suresi dolmadi");
        });

        it("Should execute update after timelock expires", async function () {
            await contract.initiateHeirUpdate(0, heir2.address, 80, "New Primary");

            // 24 saat + 1 saniye geç
            await ethers.provider.send("evm_increaseTime", [86401]);
            await ethers.provider.send("evm_mine");

            await expect(contract.executeHeirUpdate(0)).to.not.be.reverted;

            const heir = await contract.getHeir(0);
            expect(heir.wallet).to.equal(heir2.address);
            expect(heir.percentage).to.equal(80);
        });

        it("Should cancel pending update", async function () {
            await contract.initiateHeirUpdate(0, heir2.address, 80, "New Primary");
            await contract.cancelHeirUpdate(0);

            const pending = await contract.getPendingChange(0);
            expect(pending.exists).to.be.false;
        });
    });

    // ===========================================
    // 4. INHERITANCE DISTRIBUTION TESTS
    // ===========================================

    describe("4. Inheritance Distribution", function () {

        it("Should distribute to single heir correctly", async function () {
            const depositAmount = ethers.parseEther("1.0");

            await owner.sendTransaction({
                to: await contract.getAddress(),
                value: depositAmount
            });

            await contract.connect(oracle).simulateOracleSignal();

            const heirBalanceBefore = await ethers.provider.getBalance(heir1.address);

            const tx = await contract.connect(heir1).claimInheritance();
            const receipt = await tx.wait();
            const gasUsed = receipt.gasUsed * receipt.gasPrice;

            const heirBalanceAfter = await ethers.provider.getBalance(heir1.address);

            expect(heirBalanceAfter).to.be.closeTo(
                heirBalanceBefore + depositAmount - gasUsed,
                ethers.parseEther("0.01")
            );
        });

        it("Should distribute to multiple heirs by percentage", async function () {
            const depositAmount = ethers.parseEther("10.0");

            // Varisleri ayarla: 50%, 30%, 20%
            await contract.initiateHeirUpdate(0, heir1.address, 50, "Heir 1");
            await ethers.provider.send("evm_increaseTime", [86401]);
            await ethers.provider.send("evm_mine");
            await contract.executeHeirUpdate(0);

            await contract.addHeir(heir2.address, 30, "Heir 2");
            await contract.addHeir(heir3.address, 20, "Heir 3");

            // ETH yatır
            await owner.sendTransaction({
                to: await contract.getAddress(),
                value: depositAmount
            });

            // Oracle tetikle
            await contract.connect(oracle).simulateOracleSignal();

            // Bakiyeleri kaydet
            const h1Before = await ethers.provider.getBalance(heir1.address);
            const h2Before = await ethers.provider.getBalance(heir2.address);
            const h3Before = await ethers.provider.getBalance(heir3.address);

            // Claim
            await contract.connect(heir1).claimInheritance();

            // Sonuçları kontrol et
            const h1After = await ethers.provider.getBalance(heir1.address);
            const h2After = await ethers.provider.getBalance(heir2.address);
            const h3After = await ethers.provider.getBalance(heir3.address);

            // Heir1 ~5 ETH almalı (50%)
            expect(h1After - h1Before).to.be.closeTo(ethers.parseEther("5.0"), ethers.parseEther("0.1"));
            // Heir2 ~3 ETH almalı (30%)
            expect(h2After - h2Before).to.be.closeTo(ethers.parseEther("3.0"), ethers.parseEther("0.1"));
            // Heir3 ~2 ETH almalı (20%)
            expect(h3After - h3Before).to.be.closeTo(ethers.parseEther("2.0"), ethers.parseEther("0.1"));
        });

        it("Should exclude inactive heirs from distribution", async function () {
            const depositAmount = ethers.parseEther("10.0");

            // 2 varis ekle
            await contract.initiateHeirUpdate(0, heir1.address, 50, "Heir 1");
            await ethers.provider.send("evm_increaseTime", [86401]);
            await ethers.provider.send("evm_mine");
            await contract.executeHeirUpdate(0);
            await contract.addHeir(heir2.address, 50, "Heir 2");

            // Heir1'i deaktive et
            await contract.deactivateHeir(0);

            // ETH yatır
            await owner.sendTransaction({
                to: await contract.getAddress(),
                value: depositAmount
            });

            await contract.connect(oracle).simulateOracleSignal();

            const h1Before = await ethers.provider.getBalance(heir1.address);
            const h2Before = await ethers.provider.getBalance(heir2.address);

            await contract.connect(heir2).claimInheritance();

            const h1After = await ethers.provider.getBalance(heir1.address);
            const h2After = await ethers.provider.getBalance(heir2.address);

            // Heir1 hiçbir şey almamalı
            expect(h1After).to.equal(h1Before);
            // Heir2 tamamını almalı
            expect(h2After - h2Before).to.be.closeTo(depositAmount, ethers.parseEther("0.1"));
        });

        it("Should not claim before timer expires", async function () {
            await owner.sendTransaction({
                to: await contract.getAddress(),
                value: ethers.parseEther("1.0")
            });

            await expect(contract.connect(heir1).claimInheritance())
                .to.be.revertedWith("Sure dolmadi");
        });
    });

    // ===========================================
    // 5. REENTRANCY PROTECTION TESTS
    // ===========================================

    describe("5. Reentrancy Protection", function () {

        it("Should prevent reentrancy on claimInheritance", async function () {
            // Bu test için özel bir attacker contract gerekir
            // Basit test: aynı işlemi iki kez çağırma
            await owner.sendTransaction({
                to: await contract.getAddress(),
                value: ethers.parseEther("1.0")
            });

            await contract.connect(oracle).simulateOracleSignal();
            await contract.connect(heir1).claimInheritance();

            // İkinci claim başarısız olmalı (bakiye yok)
            await expect(contract.connect(heir1).claimInheritance())
                .to.be.revertedWith("Bakiye yok");
        });

        it("Should prevent reentrancy on emergencyWithdraw", async function () {
            await owner.sendTransaction({
                to: await contract.getAddress(),
                value: ethers.parseEther("1.0")
            });

            await contract.connect(owner).emergencyWithdraw();

            await expect(contract.connect(owner).emergencyWithdraw())
                .to.be.revertedWith("Bakiye yok");
        });
    });

    // ===========================================
    // 6. TIMER LOGIC TESTS
    // ===========================================

    describe("6. Timer Logic", function () {

        it("Should return correct timeLeft after deployment", async function () {
            const timeLeft = await contract.timeLeft();
            expect(timeLeft).to.be.closeTo(TIME_LIMIT, 5);
        });

        it("Should reset timer after ping", async function () {
            await ethers.provider.send("evm_increaseTime", [100]);
            await ethers.provider.send("evm_mine");

            await contract.connect(owner).ping();

            const timeLeft = await contract.timeLeft();
            expect(timeLeft).to.be.closeTo(TIME_LIMIT, 5);
        });

        it("Should return 0 after oracle signal", async function () {
            await contract.connect(oracle).simulateOracleSignal();
            expect(await contract.timeLeft()).to.equal(0);
        });

        it("Should return 0 after timer expires naturally", async function () {
            await ethers.provider.send("evm_increaseTime", [TIME_LIMIT + 1]);
            await ethers.provider.send("evm_mine");

            expect(await contract.timeLeft()).to.equal(0);
        });
    });

    // ===========================================
    // 7. EDGE CASES
    // ===========================================

    describe("7. Edge Cases", function () {

        it("Should handle zero balance claim gracefully", async function () {
            await contract.connect(oracle).simulateOracleSignal();

            await expect(contract.connect(heir1).claimInheritance())
                .to.be.revertedWith("Bakiye yok");
        });

        it("Should emit correct events", async function () {
            // Pulse event
            await expect(contract.connect(owner).ping())
                .to.emit(contract, "Pulse");

            // OracleSignalReceived event
            await expect(contract.connect(oracle).simulateOracleSignal())
                .to.emit(contract, "OracleSignalReceived")
                .withArgs("Death Confirmed by Oracle", await ethers.provider.getBlock("latest").then(b => b.timestamp + 1));

            // HeirAdded event
            await contract.connect(owner).ping(); // Reset
            await contract.initiateHeirUpdate(0, heir1.address, 50, "Test");
            await ethers.provider.send("evm_increaseTime", [86401]);
            await ethers.provider.send("evm_mine");
            await contract.executeHeirUpdate(0);

            await expect(contract.addHeir(heir2.address, 50, "New Heir"))
                .to.emit(contract, "HeirAdded")
                .withArgs(heir2.address, 50, "New Heir");
        });

        it("Should handle receive() for deposits", async function () {
            const depositAmount = ethers.parseEther("1.0");

            await expect(owner.sendTransaction({
                to: await contract.getAddress(),
                value: depositAmount
            })).to.emit(contract, "DepositReceived")
                .withArgs(owner.address, depositAmount);

            expect(await contract.currentBalance()).to.equal(depositAmount);
        });

        it("Should return all heirs with getAllHeirs()", async function () {
            const heirs = await contract.getAllHeirs();
            expect(heirs.length).to.equal(1);
            expect(heirs[0].wallet).to.equal(heir1.address);
        });
    });

    // ===========================================
    // 8. GAS OPTIMIZATION TESTS
    // ===========================================

    describe("8. Gas Optimization", function () {

        it("Should use reasonable gas for ping()", async function () {
            const tx = await contract.connect(owner).ping();
            const receipt = await tx.wait();

            // Gas should be under 50,000
            expect(receipt.gasUsed).to.be.lessThan(50000);
            console.log(`    Ping gas used: ${receipt.gasUsed}`);
        });

        it("Should use reasonable gas for addHeir()", async function () {
            await contract.initiateHeirUpdate(0, heir1.address, 50, "Test");
            await ethers.provider.send("evm_increaseTime", [86401]);
            await ethers.provider.send("evm_mine");
            await contract.executeHeirUpdate(0);

            const tx = await contract.addHeir(heir2.address, 50, "New Heir");
            const receipt = await tx.wait();

            // Gas should be under 200,000
            expect(receipt.gasUsed).to.be.lessThan(200000);
            console.log(`    AddHeir gas used: ${receipt.gasUsed}`);
        });

        it("Should use reasonable gas for claimInheritance() with 3 heirs", async function () {
            await contract.initiateHeirUpdate(0, heir1.address, 50, "Heir 1");
            await ethers.provider.send("evm_increaseTime", [86401]);
            await ethers.provider.send("evm_mine");
            await contract.executeHeirUpdate(0);
            await contract.addHeir(heir2.address, 30, "Heir 2");
            await contract.addHeir(heir3.address, 20, "Heir 3");

            await owner.sendTransaction({
                to: await contract.getAddress(),
                value: ethers.parseEther("1.0")
            });

            await contract.connect(oracle).simulateOracleSignal();

            const tx = await contract.connect(heir1).claimInheritance();
            const receipt = await tx.wait();

            // Gas should be under 300,000 for 3 heirs
            expect(receipt.gasUsed).to.be.lessThan(300000);
            console.log(`    ClaimInheritance (3 heirs) gas used: ${receipt.gasUsed}`);
        });
    });
});

// ===========================================
// MANUAL TEST CHECKLIST
// ===========================================
/*
 * Run these tests manually in Remix or via Hardhat:
 * 
 * 1. MULTI-HEIR MANAGEMENT
 *    [ ] Add up to 10 heirs
 *    [ ] Total percentage never exceeds 100%
 *    [ ] Deactivated heirs are excluded
 *    [ ] TimeLock prevents immediate changes
 * 
 * 2. INHERITANCE DISTRIBUTION
 *    [ ] Single heir gets 100%
 *    [ ] Multiple heirs get exact percentages
 *    [ ] Rounding errors handled correctly
 * 
 * 3. SECURITY
 *    [ ] ReentrancyGuard blocks attacks
 *    [ ] Only authorized users can call functions
 *    [ ] TimeLock cannot be bypassed
 * 
 * 4. GAS EFFICIENCY
 *    [ ] Ping: < 50,000 gas
 *    [ ] AddHeir: < 200,000 gas
 *    [ ] ClaimInheritance: < 300,000 gas (3 heirs)
 */
