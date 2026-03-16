# LegacyChain

Decentralized inheritance system built on Ethereum. The idea is simple: you lock your crypto assets in a smart contract, assign heirs, and if you stop "checking in" (pinging), the assets automatically get distributed to your beneficiaries.

I built this for the CENG 3550 (Decentralized Systems) course and later submitted it to Teknofest 2025 Blockchain competition.

## How it works

The owner deploys a contract with a time limit (e.g. 300 seconds for demo, much longer in practice). They need to call `ping()` periodically to prove they're still around. If the timer runs out or an oracle confirms death, heirs can claim their share.

```
Owner deploys contract → sets heirs + time limit
        ↓
Owner periodically calls ping() → timer resets
        ↓
Timer expires OR oracle signal → heirs can claim funds
```

## What's in here

- **Solidity contracts** — `Inheritance.sol` (basic version) and `MultiHeirInheritance.sol` (advanced with multi-heir, timelock, reentrancy guard)
- **Frontend** — Single-page app that connects to MetaMask, shows a live countdown, and lets the owner ping or withdraw
- **Test suite** — 40 tests covering access control, reentrancy, timelock, edge cases, gas optimization
- **Whitepaper** — [WHITEPAPER.md](WHITEPAPER.md)

## Main features

- **Multi-heir support** — Up to 10 beneficiaries with percentage-based distribution
- **TimeLock** — 24-hour delay before heir changes take effect (prevents coercion)
- **ReentrancyGuard** — Standard protection against recursive call attacks
- **Multi-sig emergency** — 2-of-3 approval for critical operations
- **Oracle integration** — Simulated oracle for immediate death signal
- **Emergency withdraw** — Owner can pull funds back anytime

## Tech

| | |
|-|-|
| Blockchain | Ethereum (Sepolia testnet) |
| Contracts | Solidity ^0.8.0 |
| Frontend | HTML + JS + Ethers.js v5.7 |
| Dev tools | Hardhat, Remix IDE |

## Running locally

```bash
git clone https://github.com/berzanunsal1621-max/LegacyChain.git
cd LegacyChain
npm install
npx http-server . -p 8080
# open http://127.0.0.1:8080
```

To deploy the contract, use Remix IDE with MetaMask (Injected Provider → Sepolia). Copy the contract address into `index.html`.

## Tests

```bash
npx hardhat test                          # run all
npx hardhat test test/security-test.js    # basic tests (10)
npx hardhat test test/multi-heir-test.js  # advanced tests (30)
```

Tests cover: access control, multi-heir management, timelock mechanism, inheritance distribution, reentrancy protection, timer logic, edge cases, and gas optimization.

## Contract overview

The main contract is `MultiHeirInheritance.sol`:

```solidity
// Key state
address public owner;
address public oracle;
uint256 public lastSeen;     // last ping timestamp
uint256 public timeLimit;    // inactivity threshold

// Key functions
ping()                    // owner proves they're alive
simulateOracleSignal()    // oracle confirms death
claimInheritance()        // heir claims when timeLeft == 0
emergencyWithdraw()       // owner reclaims everything
addHeir()                 // add beneficiary with % share
```

## Author

Berzan Unsal — Computer Engineering, Mugla Sitki Kocman University
