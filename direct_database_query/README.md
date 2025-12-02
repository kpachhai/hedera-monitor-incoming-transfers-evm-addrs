# Hedera EVM Address Monitor - Option 2: Direct Database Query

## Overview

This solution monitors incoming HBAR transfers to EVM addresses by connecting directly to the Hedera Mirror Node PostgreSQL database. It reads the raw `transaction_bytes` column, decodes the original Protocol Buffer (protobuf) messages, and determines exactly how the transaction was addressed (EVM Alias vs. Entity ID).

## The Problem We're Solving

### Background

On Hedera, you can generate EVM addresses offline from ECDSA public keys (similar to Ethereum). These addresses can receive HBAR transfers before an account is formally created on the network - Hedera will "lazy-create" the account on the first transfer.

### Original Requirement

Resolving every alias via the accounts API creates excessive load on the Mirror Node. Can we instead identify the destination EVM address or Account Id by directly parsing the transaction input data?

### The Challenge

When querying standard Mirror Node APIs, the raw transaction intention is often obscured. The API returns the **resolved** Entity ID (e.g., `0.0.12345`), making it impossible to know if the sender explicitly typed an EVM address (e.g., `0x8f31...`) or the Hedera ID.

To solve this, we must bypass the API and inspect the **raw transaction protobuf** stored in the database.

## How This Solution Works

Instead of polling REST endpoints, this solution queries the database for raw bytes and performs local decoding:

```
┌─────────────────────────────────────────────────────────────┐
│                    Hedera Network                           │
│           (Consensus & Record Stream Files)                 │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 Mirror Node Importer                        │
│   (Persists raw protobuf to "transaction_bytes" column)     │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 PostgreSQL Database                         │
│           Table: transaction  Column: transaction_bytes     │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                  Your Application                           │
│                                                             │
│  1. Poll DB for recent successful transactions              │
│  2. Decode Protobuf: Transaction → Body → Transfers         │
│  3. Inspect AccountID:                                      │
│     • If alias (20 bytes) present → Sender used EVM Addr    │
│     • If accountNum present → Sender used Entity ID         │
│  4. Match against your Watchlist                            │
└─────────────────────────────────────────────────────────────┘
```

### Key Features

1.  **Source of Truth** - Decodes the actual signed transaction body sent by the user.
2.  **Determines Intent** - Distinguishes between `0x...` (Alias) and `0.0.x` (Entity ID).
3.  **Zero REST API Load** - Does not consume API rate limits; runs against your own DB.
4.  **Supports Ethereum Transactions** - Optionally decodes RLP data from `ETHEREUMTRANSACTION` types.

## Requirement Satisfaction Analysis

| Aspect | Satisfied? | Explanation |
| :--- | :--- | :--- |
| **Reduces Mirror Node Load** | ✅ Yes | We run against our own Database (or read replica). No HTTP requests are made to the Mirror Node API. |
| **Identifies Transactions to Our EVM Addresses** | ✅ Yes | We detect transfers by parsing the destination `AccountID` in the protobuf transfer list. |
| **Parses Intended Destination from TX Data** | ✅ **Yes** | **This is the main advantage of Option 2.** By decoding `transaction_bytes`, we see exactly what the sender signed. We can prove if they used an EVM alias or an Entity ID. |
| **Works for Not-Yet-Created Accounts** | ✅ Yes | We match the raw 20-byte alias in the protobuf against our watchlist, regardless of whether the account exists on ledger yet. |
| **Scalable** | ⚠️ Depends | Highly efficient for the application, but requires a Mirror Node with `transaction_bytes` persistence enabled (storage cost). |

### Summary

**Option 2 is the robust, "Complete" solution:**

* ✅ **Solves the parsing problem** - We know exactly if the sender used `0x...` vs `0.0.xxxxx`.
* ✅ **Eliminates API polling** - Direct DB access is faster for high throughput.
* ❌ **Requires Infrastructure** - You must run a Mirror Node (or have DB access) and enable byte persistence.

## Prerequisites & Setup

**Crucial Step:** Your Mirror Node Importer must be configured to save raw transaction bytes. By default, this is often off to save space.

You can first run your own Solo network by following instructions at the [Solo v0.50.0 Guide](https://solo.hiero.org/v0.50.0/docs/step-by-step-guide/). Note that Solo is used for testing purposes but you would be running the mirror node on testnet or mainnet for your use case.

If running **Solo** or a custom Mirror Node, enable persistence via environment variable:

```bash
# Example for Kubernetes/Solo
kubectl set env deployment/mirror-1-importer -n ${SOLO_NAMESPACE} \
  HIERO_MIRROR_IMPORTER_PARSER_RECORD_ENTITY_PERSIST_TRANSACTIONBYTES=true

# Restart the importer
kubectl -n ${SOLO_NAMESPACE} rollout status deployment/mirror-1-importer
```

*Note: Only new transactions processed after this change will have `transaction_bytes` populated.*

## Installation

```bash
cd direct_database_query
npm install
```

## Configuration

### 1. Database Connection
Configure your DB connection via a `.env` file or environment variables:

```ini
DB_HOST=localhost
DB_PORT=5432
DB_NAME=mirror_node
DB_USER=mirror_node
DB_PASSWORD=your_password
```

### 2. Application Config
Edit `evm-address-monitor-db.js` to set your watchlist:

```javascript
  // Default watched EVM addresses (no 0x, lowercase)
  watchedEvmAddresses: new Set([
    "8f31e9fa14266c5da7f63bfc96811e08b7c09183" // Wallet A
  ]),
  addressLabels: {
    "8f31e9fa14266c5da7f63bfc96811e08b7c09183": "Wallet A"
  }
```

## Usage

### Start the Monitor

```bash
node evm-address-monitor-db.js
```

### Example Output

```
============================================================
GENERATING TEST ADDRESSES TO WATCH
============================================================
Added address to watch list: 017c807eb356f49ed39860d100697783780e8160 (Test Wallet 1)

============================================================
EVM ADDRESS MONITOR (Database Approach)
============================================================
[2025-12-01T22:46:43.595Z] polls=5 scanned=353 matches=0...

🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉
INCOMING TRANSFER DETECTED!
🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉
  To: 0x017c807eb356f49ed39860d100697783780e8160 (Test Wallet 1)
  Amount: 0.01000000 ℏ
  Transaction Hash: 14e690dbe...
  Timestamp: 1764629203378649715
  Sender used: EVM Address (Alias)
============================================================
{
  "evmAddress": "017c807eb356f49ed39860d100697783780e8160",
  "label": "Test Wallet 1",
  "amountTinybar": "1000000",
  "amountHbar": "0.01000000 ℏ",
  "transactionHash": "14e690dbe...",
  "consensusTimestamp": "1764629203378649715",
  "senderUsedEvmAddress": true,
  "transactionType": "CRYPTOTRANSFER",
  "detectionMethod": "transaction_bytes",
  "memo": "Test transfer to monitored EVM address"
}
```

### Send a Test Transfer

In another terminal:

```bash
node send-test-transfer.js 0x017c807eb356f49ed39860d100697783780e8160
```

## Technical Details: Logic Flow

The monitor performs the following decoding logic on every matching row:

1.  **Transaction.decode(transaction_bytes)** -> Gets the `SignedTransaction` bytes.
2.  **SignedTransaction.decode(...)** -> Gets the `TransactionBody` bytes.
3.  **TransactionBody.decode(...)** -> Reveals the actual transfer instructions.

**Logic for `CryptoTransfer`:**
* Iterate through `accountAmounts`.
* **IF** `accountID.alias` is present AND length is 20 bytes:
    * Sender explicitly used an EVM address.
    * We match this against our watchlist.
* **IF** `accountID.accountNum` is present:
    * Sender used an Entity ID (0.0.x).

**Logic for `EthereumTransaction`:**
* Decode `ethereumData` (RLP encoded).
* Extract the `to` address.
* Match against watchlist.

## Limitations & Considerations

1.  **Infrastructure Requirement**: You must have access to the Mirror Node database.
2.  **Storage Growth**: Enabling `transaction_bytes` persistence increases database size significantly.
3.  **Latency**: Detection speed depends on the polling interval and the speed at which the Mirror Node Importer commits to the DB.
4.  **Database indexing**: For high production loads, ensure you have an index on `(consensus_timestamp, type)`.

## When to Use this Solution

✅ Use this option if:

* You need to know **exactly** what address format the sender used (`0x` vs `0.0.x`).
* You run your own Mirror Node or have direct DB access.
* You want to avoid making HTTP requests for every transaction check.
* You need "Proof of Intent" from the raw transaction signature.

❌ Consider [Option 1](../query_watched_evm_addrs/README.md) if:

* You only want to know if funds arrived, regardless of how they were sent.
* You do not want to manage a Mirror Node or Database infrastructure.
* You prefer a lightweight, client-side only solution.
