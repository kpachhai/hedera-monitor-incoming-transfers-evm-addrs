# Hedera EVM Address Monitor — Option 2: Direct Database Query

## Overview

Option 2 monitors incoming HBAR transfers to EVM addresses by reading your Mirror Node PostgreSQL database, decoding the original transaction protobuf bytes (the `transaction_bytes` column), and matching the intended recipient against a watchlist of EVM addresses. Because we parse the original TransactionBody protobuf we can tell exactly what the sender submitted — e.g. whether they used an EVM alias (0x...) or a Hedera entity id (0.0.x).

This README explains what the monitor does, how it satisfies the original requirement, how it works under the hood, and how to run and test it locally (Solo / mirror node).

## The Problem We're Solving

### Background

On Hedera, you can generate EVM addresses offline from ECDSA public keys (similar to Ethereum). These addresses can receive HBAR transfers before an account is formally created on the network - Hedera will "lazy-create" the account on the first transfer.

### Original Requirement

Resolving every alias via the accounts API creates excessive load on the Mirror Node. Can we instead identify the destination EVM address or Account Id by directly parsing the transaction input data?

## Why this satisfies the original requirement

Option 2 solves the requirement cleanly:

- ✅ We run against our own Mirror Node database (no REST load).
- ✅ We parse the original transaction protobuf (Transaction → SignedTransaction → TransactionBody) from the `transaction_bytes` column.
- ✅ We inspect `AccountID` values in the transfer list: if `accountID.alias` exists and is 20 bytes, the sender used an EVM alias (0x...); if `accountID.accountNum` is present, the sender used an entity id (0.0.x).
- ✅ This lets us detect transfers to watched EVM addresses, including lazy-created accounts, and determine sender intent without making per-alias REST calls.

## High-level architecture

```
Hedera Network (consensus)
    ↓
Record Stream Files (SignedTransaction / TransactionBody protobufs)
    ↓
Mirror Node Importer (optional: persist transaction_bytes)
    ↓
Postgres `transaction` table (transaction_bytes column)
    ↓
evm-address-monitor-db.js
    • polls recent successful transactions
    • decodes transaction_bytes
    • checks AccountID.alias (20 bytes) or ethereumTransaction.ethereumData
    • emits alerts when matches found
```

## How it works (technical summary)

- The monitor queries the `transaction` table for recent successful transactions (types CRYPTOTRANSFER = 14 and ETHEREUMTRANSACTION = 50).
- For each row, it reads `transaction.transaction_bytes` (a protobuf-encoded `Transaction` message).
- Decode flow:
  - Transaction.decode(transaction_bytes)
  - SignedTransaction.decode(signedTransactionBytes)
  - TransactionBody.decode(bodyBytes)
- For CryptoTransfer transactions, the code inspects `TransactionBody.cryptoTransfer.transfers.accountAmounts[]`:
  - If an `accountID.alias` field exists and its length == 20 bytes → EVM alias present (hex bytes = EVM address).
  - If `accountID.accountNum` is set → sender used an entity id.
- For EthereumTransaction, if present the monitor can decode the embedded `ethereumData` (RLP) to extract the `to` address (requires installing `ethers`).
- If the extracted EVM address matches your watchlist, the monitor emits a human-friendly notification and a JSON event with details (amount, timestamp, transactionHash, senderUsedEvmAddress, etc.).

## Quick start (local / Solo)

Prereqs

- You run a Mirror Node (Solo or cluster) with PostgreSQL and can connect to it.
- Mirror importer must persist transaction bytes (see below).
- Node.js 18+ and npm.

1. Install

```bash
cd subscribe_to_record_stream
npm install
```

2. Ensure importer persists transaction bytes

- For Solo you can set the env var on the importer deployment and it will restart:

You can first run your own Solo network by following instructions at [Solo v0.50.0 Guide](https://solo.hiero.org/v0.50.0/docs/step-by-step-guide/). Note that Solo is used for testing purposes but you would be running the mirror node on testnet or mainnet for your use case. 

By default, transaction bytes are not persisted on Solo. You can enable it by:

```bash
kubectl set env deployment/mirror-1-importer -n ${SOLO_NAMESPACE} \
  HIERO_MIRROR_IMPORTER_PARSER_RECORD_ENTITY_PERSIST_TRANSACTIONBYTES=true
# then ensure the importer restarted successfully
kubectl -n ${SOLO_NAMESPACE} rollout status deployment/mirror-1-importer
```

Note: only new transactions after the importer restarts will have `transaction_bytes` populated.

3. Configure DB connection (env or .env)

```
DB_HOST=localhost
DB_PORT=5432
DB_NAME=mirror_node
DB_USER=mirror_node
DB_PASSWORD=your_password
```

4. Start the monitor

```bash
node evm-address-monitor-db.js
```

- The shipped script watches the Wallet A address `0x8f31e9f...` and also auto-generates 3 test addresses (same UX as Option 1). To monitor additional addresses, add them to the `watchedEvmAddresses` set in the script.

## Example output

When a match is found the script prints a human-friendly block and a JSON object for programmatic use:

```
[2025-12-01T22:46:43.595Z] polls=5 scanned=353 matches=0 (0 native, 0 EVM)   
============================================================
💰 INCOMING TRANSFER DETECTED!
============================================================
  To: 0x017c807eb356f49ed39860d100697783780e8160 (Test Wallet 1)
  Amount: 0.01000000 ℏ
  Transaction Hash: 14e690dbe42d73be4b97a8525d910f36e0f308d913fadd127af1e9089d917e864356a96d28f848fc40df59c6cb095a2b
  Timestamp: 1764629203378649715
  Sender used: EVM Address
============================================================
{
  "evmAddress": "017c807eb356f49ed39860d100697783780e8160",
  "label": "Test Wallet 1",
  "amountTinybar": "1000000",
  "amountHbar": "0.01000000 ℏ",
  "transactionHash": "14e690dbe42d73be4b97a8525d910f36e0f308d913fadd127af1e9089d917e864356a96d28f848fc40df59c6cb095a2b",
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
node send-test-transfer. js 0x017c807eb356f49ed39860d100697783780e8160
```

## Notes on ETH transactions

- `ETHEREUMTRANSACTION` rows embed the RLP-encoded Ethereum transaction in `ethereumTransaction.ethereumData`.
- The monitor optionally decodes that (if `ethers` is installed) to extract the `to` address and `value` (in wei). Converting that value to tinybar/HBAR would require business-specific logic (not automatic).
- If you don't install `ethers`, the script still detects alias-based CRYPTOTRANSFER entries.

## Configuration and customization

- Add watched addresses by editing `evm-address-monitor-db.js` `watchedEvmAddresses` set, or modify the script to read env var `WATCHED_EVM_ADDRESSES` if you prefer dynamic configuration.
- Poll frequency, lookback window, and batch size are configurable via environment variables (`POLLING_INTERVAL_MS`, `LOOKBACK_SECONDS`, `BATCH_LIMIT`).

## Database considerations & indexing

- For large datasets, add an index to improve polling speed:

```sql
CREATE INDEX IF NOT EXISTS idx_transaction_consensus_type ON transaction (consensus_timestamp, type) WHERE result = 22;
```

- Tune `BATCH_LIMIT` and polling interval to balance latency and DB load.

## Troubleshooting

- No detections:
  - Confirm `transaction_bytes` exists (LENGTH(transaction_bytes) > 0) for transactions processed after enabling persistence.
  - Confirm watched addresses are in the watchlist (hex no-0x, lowercase).
- `transaction_bytes` empty:
  - Ensure importer env var is set and importer has restarted.
  - Only transactions after enablement include bytes unless you re-ingest record files.
- If you want SDK-style transaction IDs reconstructed, the script can extract TransactionBody.transactionID and format it like `0.0.x@seconds.nanos` — ask and it will be added.

## Comparison to Option 1 (REST polling)

- Option 1 (polling accounts via Mirror REST) is simple and fine if you only need to know that your watched EVM addresses received funds — it scales with your watchlist.
- Option 2 (DB parsing) is required if you need to know the _format_ the sender used (EVM alias vs entity id). It removes REST load and gives definitive proof (from the original protobuf) of sender intent.

## When to use Option 2

Use Option 2 when:

- You run your own Mirror Node (or have DB access).
- You must know whether the sender used EVM alias vs entity id.
- You want to avoid heavy per-alias rest calls and need accurate source-of-truth parsing.
