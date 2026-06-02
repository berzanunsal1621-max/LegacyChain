# LegacyChain Oracle v2 Blueprint

## Goal

Turn the current "signal counter" oracle into a defensible attestation and dispute system that experts can review without immediately rejecting the death verification model.

This blueprint is intentionally grounded in the current codebase:

- [contracts/OracleRegistry.sol](/C:/Users/BerzanUnsal/OneDrive%20-%20Mu%C4%9Fla%20S%C4%B1tk%C4%B1%20Ko%C3%A7man%20%C3%9Cniversitesi/Ceng_projects/LegacyChain/contracts/OracleRegistry.sol)
- [contracts/InheritanceVault.sol](/C:/Users/BerzanUnsal/OneDrive%20-%20Mu%C4%9Fla%20S%C4%B1tk%C4%B1%20Ko%C3%A7man%20%C3%9Cniversitesi/Ceng_projects/LegacyChain/contracts/InheritanceVault.sol)
- [oracle-backend/server.js](/C:/Users/BerzanUnsal/OneDrive%20-%20Mu%C4%9Fla%20S%C4%B1tk%C4%B1%20Ko%C3%A7man%20%C3%9Cniversitesi/Ceng_projects/LegacyChain/oracle-backend/server.js)

The product language should shift from "death oracle" to:

**attestation, consensus, grace period, and dispute infrastructure for inheritance execution**

## Current State

### What is already good

- Authorities are registered on-chain.
- Authority role metadata already exists.
- Metadata hashes are already emitted with attestations.
- Consensus threshold already exists.
- Vaults can reset signals on owner activity.
- Grace period already exists before claim execution.
- Backend already has notification, API key, rate limit, and signal logging.

### What is still weak

- The current model is user-level, not case-level.
- There is no dispute state machine.
- Threshold is count-based only, not category-aware.
- Backend relays signals, but attestations are not modeled as signed review artifacts.
- Evidence exists only as a generic metadata hash payload.
- There is no clear operational rule for authority onboarding, revocation, or review.
- A single endpoint can push the system too quickly toward "death confirmed."

## Oracle v2 Principles

1. A single source must never open claims.
2. Consensus should depend on authority category, not just raw count.
3. Every attestation must belong to a review case.
4. Every case must support dispute and cancel paths.
5. On-chain state should stay compact; evidence should stay off-chain with hashes on-chain.
6. The owner must always get a visible chance to cancel during grace period.
7. Backend should relay and audit, not secretly decide.

## Target Architecture

### Layer 1: Proof-of-Life

Inputs:

- owner ping
- owner wallet activity
- browser notification acknowledgement
- optional email confirmation

Purpose:

- prove the owner is active
- reset false alarms
- close weak cases before escalation

### Layer 2: Concern Intake

Inputs:

- heir concern request
- legal representative concern request
- family concern request
- manual operator review request

Purpose:

- open a case without directly declaring death
- collect context before authority attestations begin

### Layer 3: Authority Attestation

Authority categories:

- `GOVERNMENT`
- `MEDICAL`
- `LEGAL`
- `FAMILY`

Purpose:

- produce category-tagged attestations
- attach evidence hashes
- move the case toward consensus

### Layer 4: Dispute and Grace

States:

- `HEALTHY`
- `WATCH`
- `CASE_OPEN`
- `ATTESTATION_PENDING`
- `ATTESTED`
- `GRACE_ACTIVE`
- `DISPUTED`
- `CANCELED`
- `CLAIMABLE`
- `RESOLVED`

Purpose:

- separate suspicion from execution
- give the owner a clear recovery path
- create a reviewable timeline

## Contract Model Changes

### 1. Replace user-only signal tracking with case-aware tracking

Current contract tracks:

- `deathSignals[user][authority]`
- `signalCount[user]`
- `attestations[user][]`

Oracle v2 should track:

- `currentCaseId[user]`
- `cases[caseId]`
- `attestationsByCase[caseId][]`
- `categoryVotes[caseId][category]`
- `authoritySubmitted[caseId][authority]`

### 2. New structs

In `OracleRegistry.sol`:

```solidity
enum CaseStatus {
    NONE,
    WATCH,
    CASE_OPEN,
    ATTESTED,
    GRACE_ACTIVE,
    DISPUTED,
    CANCELED,
    CLAIMABLE,
    RESOLVED
}

struct CaseRecord {
    bytes32 caseId;
    address user;
    address vault;
    CaseStatus status;
    uint64 openedAt;
    uint64 attestedAt;
    uint64 graceStartedAt;
    uint64 resolvedAt;
    uint8 categoryCount;
    bool ownerResponded;
}

struct AttestationRecord {
    address authority;
    bytes32 category;
    bytes32 sourceType;
    bytes32 metadataHash;
    bytes32 evidenceHash;
    uint64 timestamp;
}
```

### 3. New events

```solidity
event CaseOpened(bytes32 indexed caseId, address indexed user, address indexed vault, bytes32 reason);
event AttestationSubmitted(bytes32 indexed caseId, address indexed authority, bytes32 indexed category, bytes32 metadataHash, bytes32 evidenceHash);
event CaseStatusChanged(bytes32 indexed caseId, CaseStatus previousStatus, CaseStatus newStatus, address actor);
event DisputeOpened(bytes32 indexed caseId, address indexed actor, bytes32 disputeHash);
event DisputeResolved(bytes32 indexed caseId, address indexed actor, bool canceled);
event GracePeriodActivated(bytes32 indexed caseId, address indexed user, uint256 timestamp);
```

### 4. Consensus rules

Do not rely only on `requiredSignals = 2`.

Recommended first production rule:

- valid if `GOVERNMENT + MEDICAL`
- valid if `GOVERNMENT + LEGAL`
- valid if `MEDICAL + LEGAL + WATCH escalation`

Implementation approach:

- keep `requiredSignals` as a fallback threshold
- add category-aware checks in `canAdvanceToAttested(caseId)`

### 5. Signed attestation support

Current model accepts on-chain submissions from authority wallets.

Oracle v2 should support:

- `submitSignedAttestation(...)`
- EIP-712 signature verification
- replay protection with per-authority nonce

This allows:

- backend relaying
- future partner integrations
- auditable authority-signed messages

### 6. Dispute support

Add:

- `openDispute(bytes32 caseId, bytes32 disputeHash)`
- `cancelCase(bytes32 caseId)`
- `markClaimable(bytes32 caseId)`
- `resolveDispute(bytes32 caseId, bool canceled)`

### 7. Vault integration updates

`InheritanceVault.sol` currently checks:

- `isDeathConfirmed(owner)`
- `resetSignals(owner)`

Oracle v2 should expose:

- `getCaseStatus(address user) returns (CaseStatus)`
- `canStartGracePeriod(address user) returns (bool)`
- `resetCase(address user)`
- `getCurrentCaseId(address user) returns (bytes32)`

Vault logic should use case status rather than raw signal count.

## Backend Model Changes

Current backend stores:

- `signal-log.json`
- `notification-subscribers.json`

Oracle v2 backend should introduce a case store.

### 1. Case schema

Suggested backend case record:

```json
{
  "caseId": "0x...",
  "userAddress": "0x...",
  "vaultAddress": "0x...",
  "status": "CASE_OPEN",
  "openedAt": "2026-05-20T10:00:00.000Z",
  "reason": "manual_concern",
  "signals": [],
  "evidence": [],
  "notifications": [],
  "dispute": null
}
```

### 2. New backend endpoints

In [oracle-backend/server.js](/C:/Users/BerzanUnsal/OneDrive%20-%20Mu%C4%9Fla%20S%C4%B1tk%C4%B1%20Ko%C3%A7man%20%C3%9Cniversitesi/Ceng_projects/LegacyChain/oracle-backend/server.js):

- `POST /api/cases/open`
- `GET /api/cases/:caseId`
- `GET /api/cases/user/:userAddress`
- `POST /api/cases/:caseId/attest`
- `POST /api/cases/:caseId/dispute`
- `POST /api/cases/:caseId/cancel`
- `POST /api/cases/:caseId/start-grace`
- `POST /api/cases/:caseId/resolve`
- `GET /api/cases`

### 3. Backend responsibilities

The backend should:

- validate input shape
- persist case timeline
- relay signed attestations
- send notifications
- maintain evidence references
- expose status for the UI

The backend should not:

- silently override consensus
- mark death confirmed outside the contract flow
- mutate case history without logging

### 4. Storage recommendation

Short term:

- SQLite or JSON + append-only audit trail

Better:

- SQLite for local finalist demo
- Postgres for hosted pilot

Recommended tables:

- `cases`
- `attestations`
- `evidence_refs`
- `notifications`
- `disputes`
- `authority_actions`

### 5. Authority operations

Add operational rules for:

- onboarding
- offboarding
- rotation
- key compromise
- temporary suspension

Suggested env expansion:

- `AUTHORITY_<ROLE>_PUBLIC_ADDRESS`
- `AUTHORITY_<ROLE>_PRIVATE_KEY`
- `AUTHORITY_<ROLE>_CATEGORY`
- `AUTHORITY_<ROLE>_DISPLAY_NAME`

## UI Changes

The dashboard should stop presenting oracle as a single button action.

### New UI surfaces

1. **Case Status Panel**
   - case ID
   - current status
   - opened time
   - current required categories
   - dispute state

2. **Attestation Timeline**
   - who attested
   - category
   - timestamp
   - evidence hash summary

3. **Grace Period Panel**
   - grace start time
   - time remaining
   - owner cancel CTA
   - claim availability state

4. **Authority Health**
   - active authorities
   - categories represented
   - last seen / key rotation state

5. **Notifications**
   - browser notification status
   - email registration status
   - last alert sent

### UI rules

- Never show "death confirmed" immediately after one signal.
- Use language like `case opened`, `attestation received`, `grace active`, `claimable`.
- Show owner recovery/cancel options very clearly.

## Test Plan

### Contract tests

Create or extend tests for:

- case opening
- category-aware consensus
- duplicate authority prevention per case
- signed attestation replay protection
- dispute opening and cancel flow
- grace activation only after valid consensus
- owner activity resetting case state
- authority rotation with active/inactive state

### Backend tests

- case creation validation
- case persistence
- attestation relay validation
- notification on case state changes
- dispute lifecycle
- API key enforcement
- audit log persistence

### UI checks

- dashboard renders case state correctly
- no fake oracle labels remain
- notification registration works
- case timeline updates from backend state

## Implementation Phases

### Phase 1: Case and Status Backbone

Files:

- [contracts/OracleRegistry.sol](/C:/Users/BerzanUnsal/OneDrive%20-%20Mu%C4%9Fla%20S%C4%B1tk%C4%B1%20Ko%C3%A7man%20%C3%9Cniversitesi/Ceng_projects/LegacyChain/contracts/OracleRegistry.sol)
- [oracle-backend/server.js](/C:/Users/BerzanUnsal/OneDrive%20-%20Mu%C4%9Fla%20S%C4%B1tk%C4%B1%20Ko%C3%A7man%20%C3%9Cniversitesi/Ceng_projects/LegacyChain/oracle-backend/server.js)

Tasks:

- add case structs and statuses
- add `openCase`
- add `getCurrentCaseId`
- add `getCaseStatus`
- persist backend case records

### Phase 2: Attestations and Category Consensus

Files:

- [contracts/OracleRegistry.sol](/C:/Users/BerzanUnsal/OneDrive%20-%20Mu%C4%9Fla%20S%C4%B1tk%C4%B1%20Ko%C3%A7man%20%C3%9Cniversitesi/Ceng_projects/LegacyChain/contracts/OracleRegistry.sol)
- [test/oracle-extended-test.js](/C:/Users/BerzanUnsal/OneDrive%20-%20Mu%C4%9Fla%20S%C4%B1tk%C4%B1%20Ko%C3%A7man%20%C3%9Cniversitesi/Ceng_projects/LegacyChain/test/oracle-extended-test.js)

Tasks:

- add category-aware attestation counting
- add evidence hash field
- add case events
- add tests for valid category combinations

### Phase 3: Dispute and Grace Flow

Files:

- [contracts/OracleRegistry.sol](/C:/Users/BerzanUnsal/OneDrive%20-%20Mu%C4%9Fla%20S%C4%B1tk%C4%B1%20Ko%C3%A7man%20%C3%9Cniversitesi/Ceng_projects/LegacyChain/contracts/OracleRegistry.sol)
- [contracts/InheritanceVault.sol](/C:/Users/BerzanUnsal/OneDrive%20-%20Mu%C4%9Fla%20S%C4%B1tk%C4%B1%20Ko%C3%A7man%20%C3%9Cniversitesi/Ceng_projects/LegacyChain/contracts/InheritanceVault.sol)
- [oracle-backend/server.js](/C:/Users/BerzanUnsal/OneDrive%20-%20Mu%C4%9Fla%20S%C4%B1tk%C4%B1%20Ko%C3%A7man%20%C3%9Cniversitesi/Ceng_projects/LegacyChain/oracle-backend/server.js)

Tasks:

- add dispute state transitions
- gate grace period on case state
- add owner cancel and reset behavior
- send notifications on dispute and grace transitions

### Phase 4: Signed Attestation Relay

Files:

- [contracts/OracleRegistry.sol](/C:/Users/BerzanUnsal/OneDrive%20-%20Mu%C4%9Fla%20S%C4%B1tk%C4%B1%20Ko%C3%A7man%20%C3%9Cniversitesi/Ceng_projects/LegacyChain/contracts/OracleRegistry.sol)
- [oracle-backend/server.js](/C:/Users/BerzanUnsal/OneDrive%20-%20Mu%C4%9Fla%20S%C4%B1tk%C4%B1%20Ko%C3%A7man%20%C3%9Cniversitesi/Ceng_projects/LegacyChain/oracle-backend/server.js)

Tasks:

- add EIP-712 attestation schema
- add nonce and replay protection
- let backend relay signed attestations
- log signature origin and verification result

### Phase 5: Operator and Expert Review UX

Files:

- [index.html](/C:/Users/BerzanUnsal/OneDrive%20-%20Mu%C4%9Fla%20S%C4%B1tk%C4%B1%20Ko%C3%A7man%20%C3%9Cniversitesi/Ceng_projects/LegacyChain/index.html)
- [oracle-backend/server.js](/C:/Users/BerzanUnsal/OneDrive%20-%20Mu%C4%9Fla%20S%C4%B1tk%C4%B1%20Ko%C3%A7man%20%C3%9Cniversitesi/Ceng_projects/LegacyChain/oracle-backend/server.js)

Tasks:

- add case status cards
- add attestation timeline
- add dispute controls
- add authority registry overview

## Acceptance Criteria

Oracle v2 is ready for expert demo review when:

- a case can be opened without instantly confirming death
- independent authority categories are visible and enforced
- every attestation has a case ID and evidence hash
- owner activity can cancel a false path before claim opens
- grace period is tied to case state, not just raw counter state
- backend logs a full case timeline
- the UI explains the process honestly

## Product Positioning After Oracle v2

After this work, LegacyChain can be presented as:

**an inheritance execution protocol for self-custody digital assets, with an attestation-driven oracle layer and dispute-aware grace flow**

It should still not be presented as:

- automatic legal death determination
- exchange account extraction
- universal inheritance settlement for off-chain assets

## Recommended Next Move

Implement **Phase 1** immediately:

- add case/status storage to `OracleRegistry.sol`
- add case persistence endpoints in `server.js`
- update UI to show a real case state instead of just oracle count

That is the smallest change that makes the oracle story feel like a real system instead of a demo trigger.
