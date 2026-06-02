function calculateProofOfLifeRisk(input = {}) {
    const total = Math.max(Number(input.totalSeconds || 1), 1);
    const remainingRatio = Math.max(0, Math.min(1, Number(input.remainingSeconds || 0) / total));
    const signatureCount = Number(input.signatureCount || 0);
    const assetBalanceEth = Number(input.assetBalanceEth || 0);
    const pendingEth = Number(input.pendingEth || 0);
    const heirCount = Number(input.heirCount || 0);
    const activityCount = Number(input.activityCount || 0);

    let riskScore = Math.round((1 - remainingRatio) * 30);
    riskScore += Math.min(signatureCount, 3) * 18;
    if (input.graceActive) riskScore += 25;
    if (assetBalanceEth > 0) riskScore += 7;
    if (pendingEth > 0) riskScore += 6;
    if (heirCount === 0) riskScore += 10;
    if (activityCount === 0) riskScore += 4;

    riskScore = Math.max(0, Math.min(100, riskScore));
    const safetyScore = 100 - riskScore;
    const status = riskScore >= 75 ? "CRITICAL" : riskScore >= 50 ? "HIGH" : riskScore >= 25 ? "WATCH" : "LOW";
    const action = input.graceActive
        ? "Review oracle evidence and cancel the grace period if this is a false signal."
        : signatureCount > 0
            ? "Check the authority registry and verify submitted attestations."
            : remainingRatio < 0.25
                ? "Send a proof-of-life ping to refresh the vault timer."
                : "Keep regular proof-of-life pings active.";
    const explanation = `${Math.round(remainingRatio * 100)}% timer remaining, ${signatureCount} oracle signal(s), ${heirCount} active heir record(s).`;

    return { riskScore, safetyScore, status, action, explanation };
}

module.exports = { calculateProofOfLifeRisk };
