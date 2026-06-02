const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "..", "oracle-backend", ".test-data");
fs.rmSync(dataDir, { recursive: true, force: true });

process.env.API_KEY = "test-api-key";
process.env.DATA_DIR = dataDir;
process.env.NOTIFICATION_EMAILS = "";

const { app } = require("../oracle-backend/server");

describe("Oracle backend notification API", function () {
    let server;
    let baseUrl;

    before(function (done) {
        server = app.listen(0, () => {
            baseUrl = `http://127.0.0.1:${server.address().port}`;
            done();
        });
    });

    after(function (done) {
        server.close(done);
    });

    after(function () {
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    it("requires the API key for notification registration", async function () {
        const response = await fetch(`${baseUrl}/api/notifications/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                userAddress: "0x0000000000000000000000000000000000000001",
                email: "judge@example.com",
            }),
        });

        expect(response.status).to.equal(401);
    });

    it("returns a safe no-recipient response without SMTP access", async function () {
        const response = await fetch(`${baseUrl}/api/notifications/test`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-API-Key": "test-api-key",
            },
            body: JSON.stringify({
                userAddress: "0x0000000000000000000000000000000000000001",
            }),
        });
        const body = await response.json();

        expect(response.status).to.equal(200);
        expect(body.success).to.equal(false);
        expect(body.reason).to.include("No notification recipients");
    });

    it("persists notification subscribers", async function () {
        const response = await fetch(`${baseUrl}/api/notifications/register`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-API-Key": "test-api-key",
            },
            body: JSON.stringify({
                userAddress: "0x0000000000000000000000000000000000000001",
                email: "judge@example.com",
            }),
        });
        const body = await response.json();

        expect(response.status).to.equal(200);
        expect(body.success).to.equal(true);

        const stored = JSON.parse(fs.readFileSync(path.join(dataDir, "notification-subscribers.json"), "utf8"));
        expect(stored).to.have.length(1);
        expect(stored[0].email).to.equal("judge@example.com");
    });

    it("exposes an empty case list behind API key auth", async function () {
        const response = await fetch(`${baseUrl}/api/cases`, {
            headers: { "X-API-Key": "test-api-key" },
        });
        const body = await response.json();

        expect(response.status).to.equal(200);
        expect(body.totalCases).to.equal(0);
        expect(body.cases).to.deep.equal([]);
    });

    it("returns a neutral user case status when no oracle contract is configured", async function () {
        const response = await fetch(`${baseUrl}/api/cases/user/0x0000000000000000000000000000000000000001`, {
            headers: { "X-API-Key": "test-api-key" },
        });
        const body = await response.json();

        expect(response.status).to.equal(200);
        expect(body.caseStatus).to.equal("NONE");
        expect(body.storedCase).to.equal(null);
    });

    it("returns 404 when disputing an unknown case", async function () {
        const response = await fetch(`${baseUrl}/api/cases/0xdeadbeef/dispute`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-API-Key": "test-api-key",
            },
            body: JSON.stringify({ authorityRole: "legal" }),
        });

        expect(response.status).to.equal(404);
    });
});
