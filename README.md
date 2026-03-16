# LegacyChain

A decentralized digital inheritance protocol on Ethereum. LegacyChain allows users to securely lock crypto assets in a smart contract vault, assign multiple heirs with percentage-based shares, and automate the inheritance distribution through a combination of inactivity detection and decentralized oracle consensus.

## Screenshots

![Homepage](screenshots/homepage.png)

![Dashboard](screenshots/dashboard-preview.png)

![Protocol Architecture](screenshots/architecture.png)

## Overview

Traditional inheritance systems rely on centralized intermediaries — banks, lawyers, courts. LegacyChain replaces all of that with trustless, on-chain logic:

- **Vault deployment** — The owner deposits ETH into a smart contract and defines a list of beneficiaries with percentage-based allocation
- **Proof-of-Life mechanism** — The owner periodically confirms activity via `ping()`. An autonomous activity tracker (Ghost Ping) also monitors on-chain interactions
- **Oracle consensus** — A decentralized oracle network can independently verify inactivity and trigger the inheritance process without waiting for the timer
- **Grace period** — Before any transfer executes, a configurable grace period gives the owner a final window to cancel if the trigger was a false alarm
- **Automated distribution** — Once confirmed, the vault distributes funds to all active heirs based on their assigned percentages — no manual intervention needed

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   Owner      │────▶│  Smart Contract   │◀────│  Oracle Network  │
│  (Vault)     │     │  (Vault Logic)    │     │  (Death Signal)  │
└─────────────┘     └──────────────────┘     └──────────────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │  Heir 1  │ │  Heir 2  │ │  Heir N  │
        │  (40%)   │ │  (35%)   │ │  (25%)   │
        └──────────┘ └──────────┘ └──────────┘
```

## Core Features

### Security Layer
- **ReentrancyGuard** — Prevents recursive call exploits on all fund-transfer functions
- **TimeLock mechanism** — Any heir modification requires a 24-hour waiting period before execution, protecting against coercion or unauthorized changes
- **Multi-sig emergency protocol** — Critical operations (like emergency withdrawals) require 2-of-3 multi-signature approval
- **Access control** — Role-based permissions for owner, oracle, and heirs with strict modifier checks

### Inheritance Engine
- **Multi-heir support** — Up to 10 beneficiaries with named entries and percentage-based allocation
- **Decentralized Oracle** — Independent oracle contract that monitors owner activity and provides death/inactivity signals to the vault
- **Grace Period system** — Configurable safety window between trigger detection and fund distribution
- **Ghost Ping (Autonomous Activity Tracking)** — Automatically records owner's on-chain activity without requiring manual pings

### Smart Contracts

| Contract | Description |
|----------|-------------|
| `MultiHeirInheritance.sol` | Main vault contract — multi-heir management, timelock, oracle integration, reentrancy protection, grace period logic |
| `DecentralizedOracle.sol` | Oracle contract — monitors activity, provides consensus-based death signals |
| `Inheritance.sol` | Lightweight single-heir version for simpler use cases |
| `MockERC20.sol` | Test token for ERC-20 inheritance scenarios |

## Tech Stack

| Component | Technology |
|-----------|------------|
| Blockchain | Ethereum (Sepolia Testnet) |
| Smart Contracts | Solidity ^0.8.0 |
| Frontend | React (via CDN) + Tailwind CSS + Ethers.js v5.7 |
| Testing | Hardhat + Chai (40 tests) |
| Security | ReentrancyGuard, TimeLock, Multi-sig |

## Getting Started

```bash
git clone https://github.com/berzanunsal1621-max/LegacyChain.git
cd LegacyChain
npm install
npx http-server . -p 8080
# open http://127.0.0.1:8080
```

Deploy via Remix IDE → Injected Provider (MetaMask) → Sepolia network. Paste the deployed contract address into `index.html`.

## Testing

```bash
npx hardhat test                          # all 40 tests
npx hardhat test test/security-test.js    # access control, reentrancy (10)
npx hardhat test test/multi-heir-test.js  # heir management, timelock, distribution (30)
```

Test coverage includes: access control, multi-heir CRUD, timelock enforcement, inheritance claim flow, reentrancy attack simulation, timer edge cases, oracle signal handling, and gas optimization benchmarks.

## Documentation

- [Whitepaper](WHITEPAPER.md) — Full protocol specification, threat model, and design rationale

## Author

Berzan Unsal — Computer Engineering, Mugla Sitki Kocman University
