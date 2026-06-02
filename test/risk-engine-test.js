const { expect } = require("chai");
const { calculateProofOfLifeRisk } = require("../scripts/risk-engine");

describe("Proof-of-Life Risk Engine", function () {
    it("returns LOW risk for a healthy vault with time remaining", function () {
        const result = calculateProofOfLifeRisk({
            remainingSeconds: 90,
            totalSeconds: 100,
            signatureCount: 0,
            graceActive: false,
            assetBalanceEth: 1,
            pendingEth: 0,
            heirCount: 2,
            activityCount: 3
        });

        expect(result.status).to.equal("LOW");
        expect(result.safetyScore).to.be.greaterThan(75);
        expect(result.action).to.include("regular proof-of-life");
    });

    it("moves to WATCH when the timer is nearly expired", function () {
        const result = calculateProofOfLifeRisk({
            remainingSeconds: 10,
            totalSeconds: 100,
            signatureCount: 0,
            graceActive: false,
            assetBalanceEth: 0,
            pendingEth: 0,
            heirCount: 1,
            activityCount: 1
        });

        expect(result.status).to.equal("WATCH");
        expect(result.action).to.include("ping");
    });

    it("moves to HIGH when authority signals are present", function () {
        const result = calculateProofOfLifeRisk({
            remainingSeconds: 50,
            totalSeconds: 100,
            signatureCount: 2,
            graceActive: false,
            assetBalanceEth: 1,
            pendingEth: 0,
            heirCount: 1,
            activityCount: 1
        });

        expect(result.status).to.equal("HIGH");
        expect(result.action).to.include("authority registry");
    });

    it("moves to CRITICAL during grace period with consensus pressure", function () {
        const result = calculateProofOfLifeRisk({
            remainingSeconds: 0,
            totalSeconds: 100,
            signatureCount: 2,
            graceActive: true,
            assetBalanceEth: 2,
            pendingEth: 0,
            heirCount: 1,
            activityCount: 0
        });

        expect(result.status).to.equal("CRITICAL");
        expect(result.riskScore).to.equal(100);
        expect(result.action).to.include("cancel the grace period");
    });
});
