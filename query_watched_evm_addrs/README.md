# Hedera EVM Address Monitor - Option 1: REST API Polling

## Overview

This solution monitors incoming HBAR transfers to a set of known EVM addresses derived from ECDSA public keys. It uses the Hedera Mirror Node REST API to detect when transfers arrive at your watched addresses.

## The Problem We're Solving

### Background

On Hedera, you can generate EVM addresses offline from ECDSA public keys (similar to Ethereum). These addresses can receive HBAR transfers before an account is formally created on the network - Hedera will "lazy-create" the account on the first transfer.

### Original Requirement

> "In order to identify which transactions are sending to one of our EVM addresses, it requires that we call the `GET /api/v1/accounts/{idOrAliasOrEvmAddress}` endpoint **for each alias we see in a transfer transaction**, which puts a lot of load on the mirror node. So I'm looking to see if there's some other way we could parse out the intended destination, for example by parsing the transaction input data."

### The Challenge

When a user sends HBAR to an EVM address (e.g., `0x8f31e9fa14266c5da7f63bfc96811e08b7c09183`), the Hedera network:

1. Resolves the EVM address to an entity ID (e.g., `0.0.7332341`)
2. If the account doesn't exist, creates it (lazy-create)
3. Returns transaction data with only the **resolved entity ID**, not the original EVM address

The Mirror Node REST API only returns the processed/decoded transaction data in JSON format - it does **NOT** return the raw transaction bytes (protobuf) that would contain the original EVM address.

## How This Solution Works

Instead of scanning every transaction on the network and querying each alias, this solution takes a different approach:

```
┌─────────────────────────────────────────────────────────────┐
│                    Your Application                          │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │           Known EVM Addresses (Watchlist)             │   │
│  │  • 0x8f31e9fa14266c5da7f63bfc96811e08b7c09183        │   │
│  │  • 0xa3b516db046e1e6c39e84e5cf50502c67ef016c9        │   │
│  │  • 0xc792c0c2278c8a190337f314008e7e83926c3360        │   │
│  └──────────────────────────────────────────────────────┘   │
│                            │                                 │
│                            ▼                                 │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              Poll Each Address Directly               │   │
│  │                                                       │   │
│  │   GET /api/v1/accounts/0.0.{evmAddress}              │   │
│  │                                                       │   │
│  │   • Check if account exists (lazy-created?)          │   │
│  │   • Track balance changes                             │   │
│  │   • Fetch transaction history for new transfers      │   │
│  └──────────────────────────────────────────────────────┘   │
│                            │                                 │
│                            ▼                                 │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              Detect & Report Transfers                │   │
│  │                                                       │   │
│  │   • New account creation (lazy-create detected)      │   │
│  │   • Incoming HBAR transfers                          │   │
│  │   • Balance changes                                   │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Key Features

1. **Polls only your known addresses** - O(k) where k = number of your addresses
2. **Detects lazy-created accounts** - When an EVM address first receives funds
3. **Tracks balance changes** - Triggers transaction fetch on balance change
4. **Fetches transaction details** - Gets full transfer information

## Requirement Satisfaction Analysis

| Aspect                                           | Satisfied?   | Explanation                                                                                                                                                                                                                                         |
| ------------------------------------------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reduces Mirror Node Load**                     | ✅ Partially | Instead of querying every alias in every transaction (O(n × m) where n=transactions, m=aliases per tx), we query only our known addresses (O(k) where k=our watched addresses). Load is **proportional to our address count, not network traffic**. |
| **Identifies Transactions to Our EVM Addresses** | ✅ Yes       | We detect when transfers arrive at our watched EVM addresses by monitoring balance changes and fetching transaction history.                                                                                                                        |
| **Parses Intended Destination from TX Data**     | ❌ No        | We **cannot** determine from transaction data whether the sender used an EVM address or entity ID. The Mirror Node REST API doesn't expose raw transaction bytes.                                                                                   |
| **Works for Not-Yet-Created Accounts**           | ✅ Yes       | We poll EVM addresses directly via `/api/v1/accounts/0.0.{evmAddress}`, so we detect when they become active (lazy-created).                                                                                                                        |
| **Scalable**                                     | ⚠️ Depends   | Scales well for hundreds/thousands of addresses. For millions, you'd need batching/caching strategies.                                                                                                                                              |

### Summary

**Option 1 is a practical workaround, not a complete solution:**

- ✅ **Solves the load problem** - We no longer query every alias in every transaction
- ✅ **Detects transfers to our addresses** - Works for both existing and newly-created accounts
- ❌ **Does NOT parse the intended destination** - We cannot tell if sender used `0x...` vs `0.0.xxxxx`
- ❌ **Does NOT avoid the accounts endpoint** - We still use it, just more efficiently (only for our addresses)

**If you need to know the exact format the sender used (EVM address vs entity ID), you need [Option 2](../subscribe_to_record_stream/README.md).**

## Installation

```bash
cd query_watched_evm_addrs
npm install
```

## Configuration

Edit the `CONFIG` object in `evm-address-monitor.js`:

```javascript
const CONFIG = {
  // Mirror Node URL
  mirrorNodeUrl: "https://testnet.mirrornode.hedera.com",
  // For mainnet: "https://mainnet.mirrornode.hedera.com"

  // Polling interval in milliseconds
  pollingIntervalMs: 5000,

  // Your EVM addresses to monitor (without 0x prefix, lowercase)
  watchedEvmAddresses: new Set([
    "8f31e9fa14266c5da7f63bfc96811e08b7c09183",
    "a3b516db046e1e6c39e84e5cf50502c67ef016c9"
  ]),

  // Optional labels for your addresses
  addressLabels: {
    "8f31e9fa14266c5da7f63bfc96811e08b7c09183": "Treasury Wallet",
    a3b516db046e1e6c39e84e5cf50502c67ef016c9: "User Deposits"
  }
};
```

## Usage

### Start the Monitor

```bash
node evm-address-monitor.js
```

### Example Output

```
============================================================
GENERATING TEST ADDRESSES TO WATCH
============================================================
Added address to watch list: 0xc0d5974489287241059c928b031c30ed86f7cb57 (Test Wallet 1)
Added address to watch list: 0xc792c0c2278c8a190337f314008e7e83926c3360 (Test Wallet 2)
Added address to watch list: 0xe0a3b716120c125f3d0432c0beb9a2df72193023 (Test Wallet 3)

============================================================
EVM ADDRESS MONITOR (Direct Query Approach)
============================================================
Watching 4 EVM addresses
Polling interval: 5000ms

[2025-11-26T15:53:45.393Z] Poll #1 - Watching 4 addresses, 0 new accounts, 0 transfers detected

🆕🆕🆕🆕🆕🆕🆕🆕🆕🆕🆕🆕🆕🆕🆕🆕🆕🆕🆕🆕
NEW ACCOUNT CREATED (Lazy-Create)!
🆕🆕🆕🆕🆕🆕🆕🆕🆕🆕🆕🆕🆕🆕🆕🆕🆕🆕🆕🆕
{
  "evmAddress": "c0d5974489287241059c928b031c30ed86f7cb57",
  "label": "Test Wallet 1",
  "entityId": "0. 0.7335123",
  "balance": "0.01 ℏ"
}

🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉
INCOMING TRANSFER DETECTED!
🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉
{
  "evmAddress": "c0d5974489287241059c928b031c30ed86f7cb57",
  "label": "Test Wallet 1",
  "entityId": "0.0.7335123",
  "amount": "1000000 tinybar",
  "amountHbar": "0.01 ℏ",
  "transactionId": "0. 0.6493627-1764172436-770583393",
  "consensusTimestamp": "1764172440. 123456789",
  "balance": "0.01 ℏ",
  "memo": "Test transfer"
}
```

### Send a Test Transfer

In another terminal:

```bash
node send-test-transfer. js 0xc0d5974489287241059c928b031c30ed86f7cb57
```

## API Endpoints Used

| Endpoint                                          | Purpose                                  |
| ------------------------------------------------- | ---------------------------------------- |
| `GET /api/v1/accounts/0.0.{evmAddress}`           | Check if account exists, get balance     |
| `GET /api/v1/transactions?account.id={accountId}` | Fetch transaction history for an account |

## Limitations

1. **Cannot determine sender's intent**: We don't know if the sender used an EVM address (`0x...`) or entity ID (`0. 0.xxxxx`) to send the transfer.

2. **Polling delay**: There's a delay between when a transaction is confirmed and when we detect it (based on polling interval).

3. **Rate limits**: For many addresses, you may hit Mirror Node rate limits. Consider implementing:

- Batching
- Exponential backoff
- Caching

## When to Use this Solution

✅ Use this option if:

- You have a known, manageable set of EVM addresses to monitor
- You don't need to know if the sender used EVM address vs entity ID
- You want a simple solution without running your own infrastructure
- You're okay with polling-based detection

❌ Consider [Option 2](../subscribe_to_record_stream/README.md) if:

- You need to know exactly what address format the sender used
- You have access to a Mirror Node database
- You need real-time detection without polling delays
- You're processing high volumes of transactions
