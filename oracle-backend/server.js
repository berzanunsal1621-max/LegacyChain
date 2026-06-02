require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const { ethers } = require('ethers');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const PROVIDER_URL = process.env.RPC_URL || 'http://127.0.0.1:8545';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SIGNAL_LOG_PATH = process.env.SIGNAL_LOG_PATH || path.join(DATA_DIR, 'signal-log.json');
const SUBSCRIBERS_PATH = process.env.NOTIFICATION_SUBSCRIBERS_PATH || path.join(DATA_DIR, 'notification-subscribers.json');
const CASES_PATH = process.env.CASES_PATH || path.join(DATA_DIR, 'cases.json');
const DEFAULT_CORS_ORIGINS = ['http://localhost:8080', 'http://127.0.0.1:8080', 'http://localhost:5173', 'http://127.0.0.1:5173'];

let ORACLE_CONTRACT_ADDRESS = process.env.ORACLE_ADDRESS || '';
let INHERITANCE_CONTRACT_ADDRESS = process.env.INHERITANCE_ADDRESS || '';
let provider;
let oracleContract;
let inheritanceContract;
let signalLog = [];
let notificationSubscribers = [];
let caseStore = [];

const ORACLE_ABI = [
    'function openCase(address _user, address _vault, bytes32 _reason) external returns (bytes32)',
    'function submitDeathSignal(address _user) external',
    'function submitDeathSignal(address _user, bytes32 _metadataHash, bytes32 _sourceType) external',
    'function submitSignedAttestation(address _authority, address _user, bytes32 _metadataHash, bytes32 _sourceType, uint256 _nonce, uint256 _deadline, bytes _signature) external',
    'function openDispute(address _user, bytes32 _disputeHash) external',
    'function cancelCase(address _user) external',
    'function attestationNonces(address _authority) external view returns (uint256)',
    'function isDeathConfirmed(address _user) external view returns (bool)',
    'function canStartGracePeriod(address _user) external view returns (bool)',
    'function signalCount(address _user) external view returns (uint256)',
    'function hasCaseCategory(bytes32 _caseId, bytes32 _category) external view returns (bool)',
    'function canAdvanceToAttested(bytes32 _caseId) external view returns (bool)',
    'function getAuthorities() external view returns (address[] memory)',
    'function getAttestationCount(address _user) external view returns (uint256)',
    'function getAttestation(address _user, uint256 _index) external view returns (tuple(address authority, bytes32 metadataHash, bytes32 sourceType, uint256 timestamp))',
    'function getCurrentCaseId(address _user) external view returns (bytes32)',
    'function getCaseStatus(address _user) external view returns (uint8)',
    'function getCase(bytes32 _caseId) external view returns (tuple(bytes32 caseId, address user, address vault, uint8 status, bytes32 reason, uint64 openedAt, uint64 attestedAt, uint64 resolvedAt, uint8 categoryCount, bool ownerResponded))',
];

const INHERITANCE_ABI = [
    'function owner() external view returns (address)',
    'function timeLeft() external view returns (uint256)',
    'function startGracePeriod() external',
    'function deathConfirmedTime() external view returns (uint256)',
    'function GRACE_PERIOD() external view returns (uint256)',
];

function getAllowedOrigins() {
    return (process.env.CORS_ORIGIN || DEFAULT_CORS_ORIGINS.join(','))
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
}

app.use(cors({
    origin(origin, callback) {
        if (!origin) return callback(null, true);
        const allowedOrigins = getAllowedOrigins();
        if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('Origin is not allowed by CORS.'));
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'X-API-Key'],
}));

app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again later.' },
}));

const deathSignalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Death signal rate limit exceeded. Please try again later.' },
});

function apiKeyAuth(req, res, next) {
    const expectedKey = process.env.API_KEY;
    if (!expectedKey) {
        if (process.env.NODE_ENV === 'production') {
            return res.status(500).json({ error: 'Server API key is not configured.' });
        }
        return next();
    }
    if (req.headers['x-api-key'] !== expectedKey) {
        return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key.' });
    }
    next();
}

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        console.warn(`Failed to read ${filePath}: ${error.message}`);
        return fallback;
    }
}

function writeJson(filePath, value) {
    ensureDataDir();
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function normalizeAddress(value) {
    return typeof value === 'string' ? value.toLowerCase() : value;
}

function saveCases() {
    writeJson(CASES_PATH, caseStore);
}

function upsertCaseRecord(record) {
    const index = caseStore.findIndex((item) => item.caseId === record.caseId);
    if (index === -1) {
        caseStore.push(record);
    } else {
        caseStore[index] = { ...caseStore[index], ...record };
    }
    saveCases();
}

function findCaseById(caseId) {
    return caseStore.find((item) => item.caseId === caseId);
}

function findLatestCaseByUser(userAddress) {
    const normalized = normalizeAddress(userAddress);
    return [...caseStore].reverse().find((item) => normalizeAddress(item.userAddress) === normalized) || null;
}

const CASE_STATUS = {
    0: 'NONE',
    1: 'WATCH',
    2: 'CASE_OPEN',
    3: 'ATTESTED',
    4: 'GRACE_ACTIVE',
    5: 'DISPUTED',
    6: 'CANCELED',
    7: 'CLAIMABLE',
    8: 'RESOLVED',
};

function decodeCaseStatus(value) {
    return CASE_STATUS[Number(value)] || 'UNKNOWN';
}

const CATEGORY_LABELS = ['government', 'health', 'legal'];

function categoryBytes32(label) {
    return ethers.encodeBytes32String(label);
}

async function fetchOnChainCase(userAddress) {
    if (!oracleContract || !userAddress) {
        return { caseId: null, status: 'NONE', record: null, categoriesSeen: {}, consensusReady: false };
    }

    const caseId = await oracleContract.getCurrentCaseId(userAddress);
    if (!caseId || caseId === ethers.ZeroHash) {
        return { caseId: null, status: 'NONE', record: null, categoriesSeen: {}, consensusReady: false };
    }

    const status = decodeCaseStatus(await oracleContract.getCaseStatus(userAddress));
    const record = await oracleContract.getCase(caseId);
    const categoriesSeen = {};
    for (const label of CATEGORY_LABELS) {
        categoriesSeen[label] = await oracleContract.hasCaseCategory(caseId, categoryBytes32(label));
    }
    const consensusReady = await oracleContract.canAdvanceToAttested(caseId);

    return {
        caseId,
        status,
        categoriesSeen,
        consensusReady,
        record: {
            caseId: record.caseId,
            user: record.user,
            vault: record.vault,
            status: decodeCaseStatus(record.status),
            reason: record.reason,
            openedAt: Number(record.openedAt),
            attestedAt: Number(record.attestedAt),
            resolvedAt: Number(record.resolvedAt),
            categoryCount: Number(record.categoryCount),
            ownerResponded: record.ownerResponded,
        },
    };
}

async function relaySignedAttestation({ authority, userAddress, metadataHash, sourceTypeBytes }) {
    const relayer = getOperatorWallet();
    const nonce = await oracleContract.attestationNonces(authority.address);
    const network = await provider.getNetwork();
    const latestBlock = await provider.getBlock('latest');
    const deadline = Number(latestBlock.timestamp) + 15 * 60;

    const domain = {
        name: 'LegacyChainOracleRegistry',
        version: '2',
        chainId: Number(network.chainId),
        verifyingContract: ORACLE_CONTRACT_ADDRESS,
    };

    const types = {
        Attestation: [
            { name: 'authority', type: 'address' },
            { name: 'user', type: 'address' },
            { name: 'metadataHash', type: 'bytes32' },
            { name: 'sourceType', type: 'bytes32' },
            { name: 'nonce', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
        ],
    };

    const value = {
        authority: authority.address,
        user: userAddress,
        metadataHash,
        sourceType: sourceTypeBytes,
        nonce,
        deadline,
    };

    const signature = await authority.wallet.signTypedData(domain, types, value);
    const contract = oracleContract.connect(relayer);
    const tx = await contract.submitSignedAttestation(
        authority.address,
        userAddress,
        metadataHash,
        sourceTypeBytes,
        nonce,
        deadline,
        signature
    );
    const receipt = await tx.wait();

    return {
        receipt,
        relayerAddress: relayer.address,
        nonce: Number(nonce),
        deadline,
        signature,
        signatureMode: 'EIP712',
    };
}

function safeErrorResponse(res, statusCode, error, fallbackMessage) {
    console.error(`Error: ${error.message}`);
    res.status(statusCode).json({ error: fallbackMessage });
}

function loadAuthoritiesFromEnv() {
    if (process.env.AUTHORITIES_JSON) {
        return JSON.parse(process.env.AUTHORITIES_JSON);
    }

    return [
        { name: process.env.AUTHORITY_HOSPITAL_NAME || 'Hospital Authority', role: 'hospital', privateKey: process.env.AUTHORITY_HOSPITAL_PRIVATE_KEY },
        { name: process.env.AUTHORITY_GOVERNMENT_NAME || 'Civil Registry Authority', role: 'government', privateKey: process.env.AUTHORITY_GOVERNMENT_PRIVATE_KEY },
        { name: process.env.AUTHORITY_LEGAL_NAME || 'Legal Representative Authority', role: 'legal', privateKey: process.env.AUTHORITY_LEGAL_PRIVATE_KEY },
        { name: process.env.AUTHORITY_FAMILY_NAME || 'Family Representative Authority', role: 'family', privateKey: process.env.AUTHORITY_FAMILY_PRIVATE_KEY },
    ].filter((authority) => authority.privateKey);
}

const AUTHORITIES = loadAuthoritiesFromEnv();

function getAuthority(role) {
    const authority = AUTHORITIES.find((item) => item.role === role);
    if (!authority) {
        throw new Error(`Authority signer not configured for role: ${role}`);
    }
    if (!authority.wallet) {
        authority.wallet = new ethers.Wallet(authority.privateKey, provider);
        authority.address = authority.wallet.address;
    }
    return authority;
}

function getOperatorWallet() {
    if (process.env.BACKEND_OPERATOR_PRIVATE_KEY) {
        return new ethers.Wallet(process.env.BACKEND_OPERATOR_PRIVATE_KEY, provider);
    }
    if (AUTHORITIES.length > 0) return getAuthority(AUTHORITIES[0].role).wallet;
    throw new Error('No backend operator signer configured.');
}

function getTransportConfig() {
    if (process.env.SMTP_HOST) {
        return {
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT || 587),
            secure: process.env.SMTP_SECURE === 'true',
            auth: process.env.SMTP_USER ? {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            } : undefined,
        };
    }
    return null;
}

async function createTransporter() {
    const smtpConfig = getTransportConfig();
    if (smtpConfig) return nodemailer.createTransport(smtpConfig);

    const testAccount = await nodemailer.createTestAccount();
    return nodemailer.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
        auth: { user: testAccount.user, pass: testAccount.pass },
    });
}

async function sendNotificationEmail({ userAddress, subject, message }) {
    const recipients = notificationSubscribers
        .filter((item) => !userAddress || item.userAddress.toLowerCase() === userAddress.toLowerCase())
        .map((item) => item.email);

    const fallbackRecipients = (process.env.NOTIFICATION_EMAILS || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);

    const to = [...new Set([...recipients, ...fallbackRecipients])];
    if (to.length === 0) return { sent: false, reason: 'No notification recipients registered.' };

    const transporter = await createTransporter();
    const info = await transporter.sendMail({
        from: process.env.MAIL_FROM || '"LegacyChain Oracle" <oracle@legacychain.local>',
        to,
        subject,
        text: message,
    });

    return {
        sent: true,
        recipients: to,
        previewUrl: nodemailer.getTestMessageUrl(info),
    };
}

async function initialize() {
    ensureDataDir();
    signalLog = readJson(SIGNAL_LOG_PATH, []);
    notificationSubscribers = readJson(SUBSCRIBERS_PATH, []);
    caseStore = readJson(CASES_PATH, []);
    provider = new ethers.JsonRpcProvider(PROVIDER_URL);

    for (const authority of AUTHORITIES) {
        authority.wallet = new ethers.Wallet(authority.privateKey, provider);
        authority.address = authority.wallet.address;
    }

    if (ORACLE_CONTRACT_ADDRESS) {
        oracleContract = new ethers.Contract(ORACLE_CONTRACT_ADDRESS, ORACLE_ABI, provider);
    }
    if (INHERITANCE_CONTRACT_ADDRESS) {
        inheritanceContract = new ethers.Contract(INHERITANCE_CONTRACT_ADDRESS, INHERITANCE_ABI, provider);
    }
}

app.get('/api/status', async (req, res) => {
    try {
        const status = {
            system: 'online',
            oracleContract: ORACLE_CONTRACT_ADDRESS || 'not configured',
            inheritanceContract: INHERITANCE_CONTRACT_ADDRESS || 'not configured',
            authorities: AUTHORITIES.map(({ name, role, address }) => ({ name, role, address })),
            configuredAuthorityRoles: AUTHORITIES.map((authority) => authority.role),
            notificationSubscribers: notificationSubscribers.length,
            totalCases: caseStore.length,
            signalLog: signalLog.slice(-10),
        };

        if (oracleContract) {
            try {
                status.onChainAuthorities = await oracleContract.getAuthorities();
            } catch (_) {
                status.onChainAuthorities = [];
            }
        }

        res.json(status);
    } catch (error) {
        safeErrorResponse(res, 500, error, 'Failed to retrieve system status.');
    }
});

app.post('/api/config', apiKeyAuth, async (req, res) => {
    const { oracleAddress, inheritanceAddress } = req.body;

    if (oracleAddress) {
        ORACLE_CONTRACT_ADDRESS = oracleAddress;
        oracleContract = new ethers.Contract(oracleAddress, ORACLE_ABI, provider);
    }
    if (inheritanceAddress) {
        INHERITANCE_CONTRACT_ADDRESS = inheritanceAddress;
        inheritanceContract = new ethers.Contract(inheritanceAddress, INHERITANCE_ABI, provider);
    }

    res.json({ success: true, oracleAddress: ORACLE_CONTRACT_ADDRESS, inheritanceAddress: INHERITANCE_CONTRACT_ADDRESS });
});

app.post('/api/cases/open', apiKeyAuth, async (req, res) => {
    const { userAddress, vaultAddress, reason, authorityRole } = req.body;

    if (!userAddress || !authorityRole) {
        return res.status(400).json({ error: 'userAddress and authorityRole are required.' });
    }
    if (!oracleContract) {
        return res.status(400).json({ error: 'Oracle contract address is not configured.' });
    }

    try {
        const authority = getAuthority(authorityRole);
        const contract = oracleContract.connect(authority.wallet);
        const reasonTag = (reason || 'manual_concern').slice(0, 31);
        const tx = await contract.openCase(
            userAddress,
            vaultAddress || ethers.ZeroAddress,
            ethers.encodeBytes32String(reasonTag)
        );
        await tx.wait();

        const onChainCase = await fetchOnChainCase(userAddress);
        const record = {
            caseId: onChainCase.caseId,
            userAddress,
            vaultAddress: vaultAddress || onChainCase.record?.vault || ethers.ZeroAddress,
            status: onChainCase.status,
            reason: reason || 'manual_concern',
            authorityRole,
            openedAt: new Date().toISOString(),
            attestations: [],
            notifications: [],
            dispute: null,
        };
        upsertCaseRecord(record);

        res.json({ success: true, ...record, onChainCase: onChainCase.record });
    } catch (error) {
        safeErrorResponse(res, 500, error, 'Failed to open oracle case.');
    }
});

app.post('/api/death-signal', deathSignalLimiter, apiKeyAuth, async (req, res) => {
    const { userAddress, authorityRole, reportId, sourceType, metadata } = req.body;

    if (!userAddress || !authorityRole) {
        return res.status(400).json({ error: 'userAddress and authorityRole are required.' });
    }
    if (!oracleContract) {
        return res.status(400).json({ error: 'Oracle contract address is not configured.' });
    }

    try {
        const authority = getAuthority(authorityRole);
        const metadataPayload = {
            reportId: reportId || `LC-${Date.now()}`,
            sourceType: sourceType || authorityRole,
            authorityRole,
            metadata: metadata || {},
            issuedAt: new Date().toISOString(),
        };
        const metadataHash = ethers.id(JSON.stringify(metadataPayload));
        const sourceTypeBytes = ethers.encodeBytes32String((sourceType || authorityRole).slice(0, 31));
        const relay = await relaySignedAttestation({
            authority,
            userAddress,
            metadataHash,
            sourceTypeBytes,
        });
        const receipt = relay.receipt;

        const signalCount = await oracleContract.signalCount(userAddress);
        const isConfirmed = await oracleContract.isDeathConfirmed(userAddress);
        const onChainCase = await fetchOnChainCase(userAddress);
        const logEntry = {
            timestamp: new Date().toISOString(),
            userAddress,
            authority: authority.name,
            role: authority.role,
            authorityAddress: authority.address,
            txHash: receipt.hash,
            metadataHash,
            metadataPayload,
            signalCount: Number(signalCount),
            isConfirmed,
            caseId: onChainCase.caseId,
            caseStatus: onChainCase.status,
            relayerAddress: relay.relayerAddress,
            attestationNonce: relay.nonce,
            signatureMode: relay.signatureMode,
        };
        signalLog.push(logEntry);
        writeJson(SIGNAL_LOG_PATH, signalLog);

        const existingCase = findLatestCaseByUser(userAddress);
        upsertCaseRecord({
            caseId: onChainCase.caseId || existingCase?.caseId || ethers.id(`${userAddress}:${Date.now()}`),
            userAddress,
            vaultAddress: metadata?.vault || existingCase?.vaultAddress || ethers.ZeroAddress,
            status: onChainCase.status,
            reason: existingCase?.reason || 'auto_signal',
            authorityRole,
            attestations: [
                ...((existingCase && Array.isArray(existingCase.attestations)) ? existingCase.attestations : []),
                {
                    authority: authority.name,
                    authorityAddress: authority.address,
                    role: authority.role,
                    sourceType: sourceType || authorityRole,
                    metadataHash,
                    issuedAt: metadataPayload.issuedAt,
                    txHash: receipt.hash,
                    signatureMode: relay.signatureMode,
                    relayerAddress: relay.relayerAddress,
                    attestationNonce: relay.nonce,
                },
            ],
            openedAt: existingCase?.openedAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            notifications: (existingCase && Array.isArray(existingCase.notifications)) ? existingCase.notifications : [],
            dispute: existingCase?.dispute || null,
        });

        let notification = null;
        if (isConfirmed) {
            notification = await sendNotificationEmail({
                userAddress,
                subject: 'LegacyChain: Inheritance verification consensus reached',
                message: `Oracle consensus reached for ${userAddress}. Grace period can now be started.`,
            });
        }

        res.json({
            success: true,
            ...logEntry,
            onChainCase: onChainCase.record,
            categoriesSeen: onChainCase.categoriesSeen,
            consensusReady: onChainCase.consensusReady,
            signatureMode: relay.signatureMode,
            notification,
            message: isConfirmed
                ? 'Death verification consensus reached. Grace period can be started.'
                : (onChainCase.consensusReady
                    ? 'Category consensus reached. Grace period can be started.'
                    : `Signal recorded. ${signalCount}/2 confirmations available.`),
        });
    } catch (error) {
        if (error.message.includes('Already submitted')) {
            return res.status(400).json({ error: 'This authority already submitted a signal for this user.' });
        }
        if (error.message.includes('not configured')) {
            return res.status(400).json({ error: error.message });
        }
        safeErrorResponse(res, 500, error, 'Death signal processing failed.');
    }
});

app.get('/api/check-death/:userAddress', async (req, res) => {
    const { userAddress } = req.params;
    if (!oracleContract) return res.status(400).json({ error: 'Oracle contract address is not configured.' });

    try {
        const signalCount = await oracleContract.signalCount(userAddress);
        const isConfirmed = await oracleContract.isDeathConfirmed(userAddress);
        const onChainCase = await fetchOnChainCase(userAddress);
        let attestationCount = 0;
        try {
            attestationCount = Number(await oracleContract.getAttestationCount(userAddress));
        } catch (_) {}

        let inheritanceStatus = null;
        if (inheritanceContract) {
            const timeLeft = await inheritanceContract.timeLeft();
            const deathTime = await inheritanceContract.deathConfirmedTime();
            inheritanceStatus = {
                timeLeft: Number(timeLeft),
                deathConfirmedTime: Number(deathTime),
                gracePeriodStarted: Number(deathTime) > 0,
            };
        }

        res.json({
            userAddress,
            signalCount: Number(signalCount),
            requiredSignals: 2,
            isDeathConfirmed: isConfirmed,
            attestationCount,
            caseId: onChainCase.caseId,
            caseStatus: onChainCase.status,
            caseRecord: onChainCase.record,
            categoriesSeen: onChainCase.categoriesSeen,
            consensusReady: onChainCase.consensusReady,
            storedCase: findLatestCaseByUser(userAddress),
            inheritanceStatus,
        });
    } catch (error) {
        safeErrorResponse(res, 500, error, 'Failed to check death status.');
    }
});

app.post('/api/start-grace-period', apiKeyAuth, async (req, res) => {
    if (!inheritanceContract) return res.status(400).json({ error: 'Inheritance contract address is not configured.' });

    try {
        const contract = inheritanceContract.connect(getOperatorWallet());
        const tx = await contract.startGracePeriod();
        const receipt = await tx.wait();
        const vaultOwner = await inheritanceContract.owner();
        const latestCase = findLatestCaseByUser(vaultOwner);
        if (latestCase) {
            upsertCaseRecord({
                ...latestCase,
                status: 'GRACE_ACTIVE',
                graceStartedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            });
        }
        const notification = await sendNotificationEmail({
            userAddress: vaultOwner,
            subject: 'LegacyChain: Grace period started',
            message: `Grace period has started for vault owner ${vaultOwner}. The owner can still prove activity before claims open.`,
        });

        res.json({ success: true, txHash: receipt.hash, notification });
    } catch (error) {
        safeErrorResponse(res, 500, error, 'Failed to start grace period.');
    }
});

app.post('/api/cases/:caseId/dispute', apiKeyAuth, async (req, res) => {
    const record = findCaseById(req.params.caseId);
    if (!record) {
        return res.status(404).json({ error: 'Case not found.' });
    }
    if (!oracleContract) {
        return res.status(400).json({ error: 'Oracle contract address is not configured.' });
    }

    try {
        const authorityRole = req.body.authorityRole || 'legal';
        const authority = getAuthority(authorityRole);
        const disputeReason = req.body.disputeReason || 'owner_dispute';
        const disputeHash = ethers.id(JSON.stringify({
            caseId: record.caseId,
            disputeReason,
            submittedAt: new Date().toISOString(),
        }));

        const contract = oracleContract.connect(authority.wallet);
        const tx = await contract.openDispute(record.userAddress, disputeHash);
        const receipt = await tx.wait();

        const updated = {
            ...record,
            status: 'DISPUTED',
            dispute: {
                disputeHash,
                disputeReason,
                authorityRole,
                openedAt: new Date().toISOString(),
                txHash: receipt.hash,
            },
            updatedAt: new Date().toISOString(),
            notifications: [
                ...(Array.isArray(record.notifications) ? record.notifications : []),
                { type: 'DISPUTE_OPENED', createdAt: new Date().toISOString() },
            ],
        };
        upsertCaseRecord(updated);

        const notification = await sendNotificationEmail({
            userAddress: record.userAddress,
            subject: 'LegacyChain: Oracle dispute opened',
            message: `A dispute was opened for case ${record.caseId}. Claims should remain paused until the case is reviewed.`,
        });

        res.json({ success: true, case: updated, notification });
    } catch (error) {
        safeErrorResponse(res, 500, error, 'Failed to open dispute.');
    }
});

app.post('/api/cases/:caseId/cancel', apiKeyAuth, async (req, res) => {
    const record = findCaseById(req.params.caseId);
    if (!record) {
        return res.status(404).json({ error: 'Case not found.' });
    }
    if (!oracleContract) {
        return res.status(400).json({ error: 'Oracle contract address is not configured.' });
    }

    try {
        const contract = oracleContract.connect(getOperatorWallet());
        const tx = await contract.cancelCase(record.userAddress);
        const receipt = await tx.wait();

        const updated = {
            ...record,
            status: 'CANCELED',
            canceledAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            notifications: [
                ...(Array.isArray(record.notifications) ? record.notifications : []),
                { type: 'CASE_CANCELED', createdAt: new Date().toISOString() },
            ],
        };
        upsertCaseRecord(updated);

        const notification = await sendNotificationEmail({
            userAddress: record.userAddress,
            subject: 'LegacyChain: Oracle case canceled',
            message: `Case ${record.caseId} was canceled after owner recovery or administrative review.`,
        });

        res.json({ success: true, txHash: receipt.hash, case: updated, notification });
    } catch (error) {
        safeErrorResponse(res, 500, error, 'Failed to cancel case.');
    }
});

app.post('/api/cases/:caseId/start-grace', apiKeyAuth, async (req, res) => {
    const record = findCaseById(req.params.caseId);
    if (!record) {
        return res.status(404).json({ error: 'Case not found.' });
    }
    if (!inheritanceContract) {
        return res.status(400).json({ error: 'Inheritance contract address is not configured.' });
    }

    try {
        const contract = inheritanceContract.connect(getOperatorWallet());
        const tx = await contract.startGracePeriod();
        const receipt = await tx.wait();

        const updated = {
            ...record,
            status: 'GRACE_ACTIVE',
            graceStartedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            notifications: [
                ...(Array.isArray(record.notifications) ? record.notifications : []),
                { type: 'GRACE_STARTED', createdAt: new Date().toISOString() },
            ],
        };
        upsertCaseRecord(updated);

        const notification = await sendNotificationEmail({
            userAddress: record.userAddress,
            subject: 'LegacyChain: Grace period started',
            message: `Grace period has started for case ${record.caseId}. The owner can still prove activity before claims open.`,
        });

        res.json({ success: true, txHash: receipt.hash, case: updated, notification });
    } catch (error) {
        safeErrorResponse(res, 500, error, 'Failed to start case grace period.');
    }
});

app.post('/api/notifications/register', apiKeyAuth, (req, res) => {
    const { userAddress, email } = req.body;
    if (!userAddress || !email) {
        return res.status(400).json({ error: 'userAddress and email are required.' });
    }

    const normalizedUser = userAddress.toLowerCase();
    notificationSubscribers = notificationSubscribers.filter(
        (item) => !(item.userAddress.toLowerCase() === normalizedUser && item.email.toLowerCase() === email.toLowerCase())
    );
    notificationSubscribers.push({ userAddress, email, createdAt: new Date().toISOString() });
    writeJson(SUBSCRIBERS_PATH, notificationSubscribers);
    res.json({ success: true, subscribers: notificationSubscribers.length });
});

app.post('/api/notifications/test', apiKeyAuth, async (req, res) => {
    try {
        const { userAddress } = req.body;
        const result = await sendNotificationEmail({
            userAddress,
            subject: 'LegacyChain notification test',
            message: 'This is a real LegacyChain notification pipeline test.',
        });
        res.json({ success: result.sent, ...result });
    } catch (error) {
        safeErrorResponse(res, 500, error, 'Failed to send notification test.');
    }
});

app.get('/api/signal-log', (req, res) => {
    res.json({ totalSignals: signalLog.length, signals: signalLog });
});

app.get('/api/cases', apiKeyAuth, async (req, res) => {
    res.json({ totalCases: caseStore.length, cases: caseStore });
});

app.get('/api/cases/user/:userAddress', apiKeyAuth, async (req, res) => {
    try {
        const { userAddress } = req.params;
        const storedCase = findLatestCaseByUser(userAddress);
        const onChainCase = await fetchOnChainCase(userAddress);
        res.json({
            userAddress,
            storedCase,
            caseId: onChainCase.caseId,
            caseStatus: storedCase?.status || onChainCase.status,
            categoriesSeen: onChainCase.categoriesSeen,
            consensusReady: onChainCase.consensusReady,
            onChainCase: onChainCase.record,
        });
    } catch (error) {
        safeErrorResponse(res, 500, error, 'Failed to retrieve user case.');
    }
});

app.get('/api/cases/:caseId', apiKeyAuth, async (req, res) => {
    const record = findCaseById(req.params.caseId);
    if (!record) {
        return res.status(404).json({ error: 'Case not found.' });
    }
    res.json(record);
});

if (require.main === module) {
    initialize().then(() => {
        app.listen(PORT, () => {
            console.log(`LegacyChain Oracle Backend running on http://localhost:${PORT}`);
            console.log(`Configured authority roles: ${AUTHORITIES.map((a) => a.role).join(', ') || 'none'}`);
        });
    }).catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = { app, initialize, loadAuthoritiesFromEnv };
