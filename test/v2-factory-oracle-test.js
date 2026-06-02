const { ethers } = require("hardhat");
const { expect } = require("chai");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

describe("LegacyChain v2: Factory, Vault, and OracleRegistry", function () {
    let registry, factory;
    let owner, user1, user2, heir1, heir2, authGov, authHealth, authLegal, authFamily, replacement;

    const TIME_LIMIT = 3600;
    const ROLE_GOV = ethers.encodeBytes32String("government");
    const ROLE_HEALTH = ethers.encodeBytes32String("health");
    const ROLE_LEGAL = ethers.encodeBytes32String("legal");
    const ROLE_FAMILY = ethers.encodeBytes32String("family");

    beforeEach(async function () {
        [owner, user1, user2, heir1, heir2, authGov, authHealth, authLegal, authFamily, replacement] = await ethers.getSigners();

        const OracleRegistry = await ethers.getContractFactory("OracleRegistry");
        registry = await OracleRegistry.deploy();
        await registry.waitForDeployment();

        const VaultFactory = await ethers.getContractFactory("VaultFactory");
        factory = await VaultFactory.deploy(await registry.getAddress());
        await factory.waitForDeployment();

        await registry.setFactory(await factory.getAddress(), true);
        await registry.addAuthority(authGov.address, ROLE_GOV, "Civil Registry");
        await registry.addAuthority(authHealth.address, ROLE_HEALTH, "Hospital Verifier");
        await registry.addAuthority(authLegal.address, ROLE_LEGAL, "Legal Representative");
        await registry.addAuthority(authFamily.address, ROLE_FAMILY, "Family Representative");
    });

    async function createVault(user, heir) {
        const tx = await factory.connect(user).createVault(heir.address, TIME_LIMIT);
        const receipt = await tx.wait();
        const event = receipt.logs
            .map(log => {
                try { return factory.interface.parseLog(log); } catch (_) { return null; }
            })
            .find(log => log && log.name === "VaultCreated");
        return await ethers.getContractAt("InheritanceVault", event.args.vault);
    }

    async function buildSignedAttestation(authority, userAddress, metadataHash, sourceType) {
        const nonce = await registry.attestationNonces(authority.address);
        const latestBlock = await ethers.provider.getBlock("latest");
        const deadline = Number(latestBlock.timestamp) + 3600;
        const network = await ethers.provider.getNetwork();
        const domain = {
            name: "LegacyChainOracleRegistry",
            version: "2",
            chainId: Number(network.chainId),
            verifyingContract: await registry.getAddress(),
        };
        const types = {
            Attestation: [
                { name: "authority", type: "address" },
                { name: "user", type: "address" },
                { name: "metadataHash", type: "bytes32" },
                { name: "sourceType", type: "bytes32" },
                { name: "nonce", type: "uint256" },
                { name: "deadline", type: "uint256" },
            ],
        };
        const value = {
            authority: authority.address,
            user: userAddress,
            metadataHash,
            sourceType,
            nonce,
            deadline,
        };
        const signature = await authority.signTypedData(domain, types, value);
        return { nonce, deadline, signature };
    }

    it("creates independent vaults owned by each user", async function () {
        const vault1 = await createVault(user1, heir1);
        const vault2 = await createVault(user2, heir2);

        expect(await vault1.owner()).to.equal(user1.address);
        expect(await vault2.owner()).to.equal(user2.address);
        expect(await registry.registeredVaults(await vault1.getAddress())).to.equal(true);
        expect(await registry.registeredVaults(await vault2.getAddress())).to.equal(true);

        expect(await factory.getVaultCount(user1.address)).to.equal(1);
        expect(await factory.getVaultCount(user2.address)).to.equal(1);
        expect((await factory.getAllVaults()).length).to.equal(2);

        await vault1.connect(user1).addHeir(heir2.address, 30, "Second heir");
        expect(await vault1.getHeirCount()).to.equal(2);
        expect(await vault2.getHeirCount()).to.equal(1);
    });

    it("stores metadata-rich death attestations and confirms by threshold", async function () {
        const vault = await createVault(user1, heir1);
        const metadata1 = ethers.keccak256(ethers.toUtf8Bytes("death-report:registry:001"));
        const metadata2 = ethers.keccak256(ethers.toUtf8Bytes("death-report:hospital:002"));

        await expect(registry.connect(authGov).submitDeathSignal(user1.address, metadata1, ROLE_GOV))
            .to.emit(registry, "DeathSignalSubmitted")
            .withArgs(user1.address, authGov.address, metadata1, ROLE_GOV, anyValue);
        expect(await registry.isDeathConfirmed(user1.address)).to.equal(false);

        await expect(registry.connect(authHealth).submitDeathSignal(user1.address, metadata2, ROLE_HEALTH))
            .to.emit(registry, "DeathConfirmed");
        expect(await registry.isDeathConfirmed(user1.address)).to.equal(true);
        expect(await vault.timeLeft()).to.equal(0);

        const caseId = await registry.getCurrentCaseId(user1.address);
        expect(caseId).to.not.equal(ethers.ZeroHash);
        expect(await registry.getCaseStatus(user1.address)).to.equal(3);
        const caseRecord = await registry.getCase(caseId);
        expect(caseRecord.user).to.equal(user1.address);
        expect(caseRecord.status).to.equal(3);
        expect(caseRecord.categoryCount).to.equal(2);

        const first = await registry.getAttestation(user1.address, 0);
        expect(first.authority).to.equal(authGov.address);
        expect(first.metadataHash).to.equal(metadata1);
        expect(first.sourceType).to.equal(ROLE_GOV);
        expect(await registry.getAttestationCount(user1.address)).to.equal(2);
    });

    it("does not attest with unsupported category combinations even if raw count reaches the threshold", async function () {
        await createVault(user1, heir1);

        await registry.connect(authHealth).submitDeathSignal(user1.address, ethers.id("health"), ROLE_HEALTH);
        await registry.connect(authFamily).submitDeathSignal(user1.address, ethers.id("family"), ROLE_FAMILY);

        expect(await registry.signalCount(user1.address)).to.equal(2);
        expect(await registry.isDeathConfirmed(user1.address)).to.equal(false);

        const caseId = await registry.getCurrentCaseId(user1.address);
        expect(await registry.canAdvanceToAttested(caseId)).to.equal(false);
        expect(await registry.getCaseStatus(user1.address)).to.equal(2);
    });

    it("attests when government and legal categories both sign", async function () {
        await createVault(user1, heir1);

        await registry.connect(authGov).submitDeathSignal(user1.address, ethers.id("registry"), ROLE_GOV);
        await registry.connect(authLegal).submitDeathSignal(user1.address, ethers.id("legal"), ROLE_LEGAL);

        expect(await registry.isDeathConfirmed(user1.address)).to.equal(true);
        const caseId = await registry.getCurrentCaseId(user1.address);
        expect(await registry.canAdvanceToAttested(caseId)).to.equal(true);
        expect(await registry.hasCaseCategory(caseId, ROLE_GOV)).to.equal(true);
        expect(await registry.hasCaseCategory(caseId, ROLE_LEGAL)).to.equal(true);
    });

    it("accepts EIP-712 signed attestations relayed by a non-authority", async function () {
        await createVault(user1, heir1);

        const govMeta = ethers.id("signed-gov");
        const healthMeta = ethers.id("signed-health");
        const gov = await buildSignedAttestation(authGov, user1.address, govMeta, ROLE_GOV);
        const health = await buildSignedAttestation(authHealth, user1.address, healthMeta, ROLE_HEALTH);

        await expect(
            registry.connect(user2).submitSignedAttestation(
                authGov.address,
                user1.address,
                govMeta,
                ROLE_GOV,
                gov.nonce,
                gov.deadline,
                gov.signature
            )
        ).to.emit(registry, "SignedAttestationAccepted");

        await registry.connect(user2).submitSignedAttestation(
            authHealth.address,
            user1.address,
            healthMeta,
            ROLE_HEALTH,
            health.nonce,
            health.deadline,
            health.signature
        );

        expect(await registry.isDeathConfirmed(user1.address)).to.equal(true);
    });

    it("rejects replayed signed attestations with an old nonce", async function () {
        await createVault(user1, heir1);

        const metadataHash = ethers.id("replay-test");
        const signed = await buildSignedAttestation(authGov, user1.address, metadataHash, ROLE_GOV);

        await registry.connect(user2).submitSignedAttestation(
            authGov.address,
            user1.address,
            metadataHash,
            ROLE_GOV,
            signed.nonce,
            signed.deadline,
            signed.signature
        );

        await expect(
            registry.connect(user2).submitSignedAttestation(
                authGov.address,
                user1.address,
                metadataHash,
                ROLE_GOV,
                signed.nonce,
                signed.deadline,
                signed.signature
            )
        ).to.be.revertedWith("Invalid nonce");
    });

    it("moves an attested case into grace when the vault starts the safety window", async function () {
        const vault = await createVault(user1, heir1);

        await registry.connect(authGov).submitDeathSignal(user1.address, ethers.id("registry"), ROLE_GOV);
        await registry.connect(authHealth).submitDeathSignal(user1.address, ethers.id("health"), ROLE_HEALTH);

        expect(await registry.canStartGracePeriod(user1.address)).to.equal(true);
        await vault.startGracePeriod();
        expect(await registry.getCaseStatus(user1.address)).to.equal(4);
    });

    it("blocks grace activation and later claims when the case is disputed", async function () {
        const vault = await createVault(user1, heir1);
        await user1.sendTransaction({ to: await vault.getAddress(), value: ethers.parseEther("1") });

        await registry.connect(authGov).submitDeathSignal(user1.address, ethers.id("registry"), ROLE_GOV);
        await registry.connect(authHealth).submitDeathSignal(user1.address, ethers.id("health"), ROLE_HEALTH);
        await registry.connect(authLegal).openDispute(user1.address, ethers.id("owner-dispute"));

        expect(await registry.getCaseStatus(user1.address)).to.equal(5);
        await ethers.provider.send("evm_increaseTime", [TIME_LIMIT + 1]);
        await ethers.provider.send("evm_mine", []);
        await expect(vault.startGracePeriod()).to.be.revertedWith("Case not attested");

        await registry.connect(owner).cancelCase(user1.address);
        expect(await registry.getCaseStatus(user1.address)).to.equal(0);
    });

    it("lets registered vaults reset false death signals when owner proves activity", async function () {
        const vault = await createVault(user1, heir1);

        await registry.connect(authGov).submitDeathSignal(user1.address, ethers.id("registry"), ROLE_GOV);
        await registry.connect(authHealth).submitDeathSignal(user1.address, ethers.id("health"), ROLE_HEALTH);
        expect(await registry.isDeathConfirmed(user1.address)).to.equal(true);

        await vault.connect(user1).recordActivity();

        expect(await registry.signalCount(user1.address)).to.equal(0);
        expect(await registry.getAttestationCount(user1.address)).to.equal(0);
        expect(await registry.getCurrentCaseId(user1.address)).to.equal(ethers.ZeroHash);
        expect(await registry.getCaseStatus(user1.address)).to.equal(0);
        expect(await vault.timeLeft()).to.be.gt(0);
    });

    it("allows authorities to open a case before attestations start", async function () {
        const vault = await createVault(user1, heir1);
        const reason = ethers.encodeBytes32String("manual_concern");

        await expect(registry.connect(authLegal).openCase(user1.address, await vault.getAddress(), reason))
            .to.emit(registry, "CaseOpened");

        const caseId = await registry.getCurrentCaseId(user1.address);
        expect(caseId).to.not.equal(ethers.ZeroHash);

        const caseRecord = await registry.getCase(caseId);
        expect(caseRecord.user).to.equal(user1.address);
        expect(caseRecord.vault).to.equal(await vault.getAddress());
        expect(caseRecord.status).to.equal(2);
        expect(caseRecord.reason).to.equal(reason);
    });

    it("supports authority removal and rotation", async function () {
        await registry.removeAuthority(authLegal.address);
        expect((await registry.authorities(authLegal.address)).active).to.equal(false);

        await registry.rotateAuthority(authHealth.address, replacement.address, "Replacement Hospital");
        expect((await registry.authorities(authHealth.address)).active).to.equal(false);
        const rotated = await registry.authorities(replacement.address);
        expect(rotated.active).to.equal(true);
        expect(rotated.role).to.equal(ROLE_HEALTH);
    });
});
