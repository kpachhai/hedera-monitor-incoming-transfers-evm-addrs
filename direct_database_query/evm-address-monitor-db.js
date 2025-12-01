#!/usr/bin/env node
/**
 * evm-address-monitor-db.js
 *
 * DB-based EVM address monitor that parses transaction_bytes from a local
 * Mirror Node PostgreSQL database to detect transfers to watched EVM addresses.
 *
 * This variant handles both:
 *  - CRYPTOTRANSFER (native Hedera HBAR transfers with AccountID.alias)
 *  - ETHEREUMTRANSACTION (EVM transactions — we decode the embedded ethereumData
 *    to extract the `to` address and value where possible)
 *
 * Note: ETH tx value is the Ethereum value (wei) encoded in the transaction; converting
 * that to tinybar/HBAR is not automatic — the event includes the raw ethereum value.
 *
 * Dependencies:
 *   npm install pg @hashgraph/proto long dotenv @hiero-ledger/sdk ethers
 *
 * Usage:
 *   configure DB env or .env then:
 *   node evm-address-monitor-db.js
 */

require("dotenv").config();

const { Pool } = require("pg");
const protoPkg = require("@hashgraph/proto");
const Long = require("long");
const { PrivateKey } = require("@hiero-ledger/sdk");

let ethers;
try {
  // optional dependency; if missing, ETH decoding will be skipped
  ethers = require("ethers");
} catch (e) {
  ethers = null;
  console.warn(
    "ethers not available — ETH tx decoding disabled. Install 'ethers' to enable."
  );
}

// ===========================================
// CONFIGURATION
// ===========================================

const CONFIG = {
  db: {
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "5432"),
    database: process.env.DB_NAME || "mirror_node",
    user: process.env.DB_USER || "mirror_node",
    password: process.env.DB_PASSWORD || ""
  },
  pollingIntervalMs: parseInt(process.env.POLLING_INTERVAL_MS || "3000"),
  lookbackSeconds: parseInt(process.env.LOOKBACK_SECONDS || "60"),
  batchLimit: parseInt(process.env.BATCH_LIMIT || "200"),
  transactionTypes: [14, 50], // CRYPTOTRANSFER, ETHEREUMTRANSACTION
  // Default watched EVM addresses (no 0x, lowercase)
  watchedEvmAddresses: new Set([
    "8f31e9fa14266c5da7f63bfc96811e08b7c09183" // Wallet A
  ]),
  addressLabels: {
    "8f31e9fa14266c5da7f63bfc96811e08b7c09183": "Wallet A"
  }
};

// ===========================================
// UTILITIES
// ===========================================

function normalizeEvmAddress(address) {
  if (!address) return null;
  if (Buffer.isBuffer(address) || address instanceof Uint8Array) {
    return Buffer.from(address).toString("hex").toLowerCase();
  }
  return String(address).toLowerCase().replace(/^0x/, "");
}

function addWatchedAddress(evmAddress, label = null) {
  const normalized = normalizeEvmAddress(evmAddress);
  CONFIG.watchedEvmAddresses.add(normalized);
  if (label) CONFIG.addressLabels[normalized] = label;
  console.log(
    `Added address to watch list: 0x${normalized}${label ? ` (${label})` : ""}`
  );
}

function formatHbarFromTinybar(tinybarStr) {
  const t = Long.fromString(String(tinybarStr));
  const whole = t.divide(100_000_000).toNumber();
  const frac = t.mod(100_000_000).toNumber();
  return `${whole}.${String(frac).padStart(8, "0")} ℏ`;
}

function getNanosSecondsAgo(seconds) {
  const now = Date.now();
  const target = now - seconds * 1000;
  const s = Math.floor(target / 1000);
  const ns = (target % 1000) * 1_000_000;
  return `${s}${String(ns).padStart(9, "0")}`;
}

function bufferToHexMaybe(buf) {
  if (!buf && buf !== 0) return null;
  if (Buffer.isBuffer(buf)) return buf.toString("hex");
  return String(buf);
}

// ===========================================
// GENERATE TEST ADDRESSES (like option1)
// ===========================================

console.log("=".repeat(60));
console.log("GENERATING TEST ADDRESSES TO WATCH");
console.log("=".repeat(60));

// Generate 3 test addresses and add them to watch list
for (let i = 0; i < 3; i++) {
  const privateKey = PrivateKey.generateECDSA();
  const evmAddress = privateKey.publicKey.toEvmAddress();
  addWatchedAddress(evmAddress, `Test Wallet ${i + 1}`);
}
console.log();

// ===========================================
// PROTOBUF PARSER
// ===========================================

class ProtoParser {
  constructor() {
    this.proto = protoPkg;
    this.Transaction =
      this.proto?.proto?.Transaction || this.proto?.Transaction;
    this.SignedTransaction =
      this.proto?.proto?.SignedTransaction || this.proto?.SignedTransaction;
    this.TransactionBody =
      this.proto?.proto?.TransactionBody || this.proto?.TransactionBody;
  }

  parseTransactionBytes(txBytes) {
    if (!txBytes || txBytes.length === 0) return null;
    try {
      const transaction = this.Transaction.decode(txBytes);

      // various field names across proto versions
      const signedBytes =
        transaction.signedTransactionBytes ||
        transaction.signedTransaction ||
        transaction.transactionBytes ||
        transaction.transaction_bytes ||
        null;

      let txBody = null;

      if (signedBytes && signedBytes.length > 0) {
        const signed = this.SignedTransaction.decode(signedBytes);
        const bodyBytes = signed.bodyBytes || signed.body || null;
        if (bodyBytes && bodyBytes.length > 0) {
          txBody = this.TransactionBody.decode(bodyBytes);
        }
      } else if (transaction.bodyBytes && transaction.bodyBytes.length > 0) {
        txBody = this.TransactionBody.decode(transaction.bodyBytes);
      } else if (transaction.body) {
        txBody = transaction.body;
      }

      return txBody ? { txBody } : null;
    } catch (err) {
      return null;
    }
  }
}

// ===========================================
// Helper: decode ethereum tx using ethers (if available)
// ===========================================
function decodeEthereumTx(ethereumData) {
  if (!ethereumData || ethereumData.length === 0) return null;
  if (!ethers) return null;

  try {
    const hex = "0x" + Buffer.from(ethereumData).toString("hex");
    // ethers v6: ethers.parseTransaction, v5: ethers.utils.parseTransaction
    let tx;
    if (typeof ethers.parseTransaction === "function") {
      tx = ethers.parseTransaction(hex);
    } else if (
      ethers.utils &&
      typeof ethers.utils.parseTransaction === "function"
    ) {
      tx = ethers.utils.parseTransaction(hex);
    } else {
      return null;
    }

    return {
      to: tx.to ? normalizeEvmAddress(tx.to) : null,
      from: tx.from ? normalizeEvmAddress(tx.from) : null,
      value: tx.value
        ? tx.value.toString
          ? tx.value.toString()
          : String(tx.value)
        : "0",
      gasLimit: tx.gasLimit
        ? tx.gasLimit.toString
          ? tx.gasLimit.toString()
          : String(tx.gasLimit)
        : null,
      gasPrice: tx.gasPrice
        ? tx.gasPrice.toString
          ? tx.gasPrice.toString()
          : String(tx.gasPrice)
        : null,
      data: tx.data
        ? typeof tx.data === "string"
          ? tx.data.replace(/^0x/, "")
          : Buffer.from(tx.data).toString("hex")
        : null
    };
  } catch (e) {
    return null;
  }
}

// ===========================================
// MONITOR
// ===========================================

async function main() {
  const pool = new Pool(CONFIG.db);
  const parser = new ProtoParser();

  let lastConsensusTs =
    process.env.START_CONSENSUS_TIMESTAMP ||
    getNanosSecondsAgo(CONFIG.lookbackSeconds);

  console.log("=".repeat(60));
  console.log("EVM ADDRESS MONITOR - Database Edition");
  console.log("=".repeat(60));
  console.log(`Watching ${CONFIG.watchedEvmAddresses.size} addresses`);
  for (const a of CONFIG.watchedEvmAddresses) {
    console.log(
      `  0x${a}${
        CONFIG.addressLabels[a] ? ` (${CONFIG.addressLabels[a]})` : ""
      }`
    );
  }
  console.log(`Polling interval: ${CONFIG.pollingIntervalMs}ms`);
  console.log();

  const stats = {
    polls: 0,
    scanned: 0,
    matches: 0,
    cryptoTransfers: 0,
    ethereumTransactions: 0
  };

  async function pollOnce() {
    stats.polls++;
    const sql = `
      SELECT consensus_timestamp, type, result, transaction_bytes, transaction_hash
      FROM transaction
      WHERE consensus_timestamp > $1
        AND type = ANY($2)
        AND result = 22
      ORDER BY consensus_timestamp ASC
      LIMIT $3
    `;
    try {
      const res = await pool.query(sql, [
        lastConsensusTs,
        CONFIG.transactionTypes,
        CONFIG.batchLimit
      ]);
      if (!res.rows || res.rows.length === 0) {
        process.stdout.write(
          `\r[${new Date().toISOString()}] polls=${stats.polls} scanned=${
            stats.scanned
          } matches=${stats.matches}   `
        );
        return;
      }

      for (const row of res.rows) {
        stats.scanned++;
        lastConsensusTs = row.consensus_timestamp || lastConsensusTs;

        const txBytes = row.transaction_bytes;
        if (!txBytes || txBytes.length === 0) continue;

        const parsed = parser.parseTransactionBytes(txBytes);
        if (!parsed || !parsed.txBody) continue;
        const txBody = parsed.txBody;

        // ------------------------------------------
        // 1) CRYPTOTRANSFER - look for AccountID.alias
        // ------------------------------------------
        if (
          txBody.cryptoTransfer &&
          txBody.cryptoTransfer.transfers &&
          txBody.cryptoTransfer.transfers.accountAmounts
        ) {
          for (const aa of txBody.cryptoTransfer.transfers.accountAmounts) {
            const amt = Long.fromValue(aa.amount || 0);
            if (!amt.greaterThan(Long.ZERO)) continue;

            const accountId =
              aa.accountID || aa.accountId || aa.account || null;
            if (!accountId) continue;

            if (accountId.alias && accountId.alias.length === 20) {
              const evm = normalizeEvmAddress(
                Buffer.from(accountId.alias).toString("hex")
              );
              if (CONFIG.watchedEvmAddresses.has(evm)) {
                stats.matches++;
                stats.cryptoTransfers++;

                const txHashHex = bufferToHexMaybe(row.transaction_hash);
                const event = {
                  evmAddress: evm,
                  label: CONFIG.addressLabels[evm] || null,
                  amountTinybar: amt.toString(),
                  amountHbar: formatHbarFromTinybar(amt.toString()),
                  transactionHash: txHashHex,
                  consensusTimestamp: row.consensus_timestamp,
                  senderUsedEvmAddress: true,
                  transactionType: "CRYPTOTRANSFER",
                  detectionMethod: "transaction_bytes",
                  memo: txBody.memo || null
                };

                // Human-friendly output
                console.log("\n" + "=".repeat(60));
                console.log("💰 INCOMING TRANSFER DETECTED!");
                console.log("=".repeat(60));
                console.log(
                  `  To: 0x${event.evmAddress}${
                    event.label ? ` (${event.label})` : ""
                  }`
                );
                console.log(`  Amount: ${event.amountHbar}`);
                console.log(`  Transaction Hash: ${event.transactionHash}`);
                console.log(`  Timestamp: ${event.consensusTimestamp}`);
                console.log(`  Sender used: EVM Address`);
                console.log("=".repeat(60));
                console.log(JSON.stringify(event, null, 2));
              }
            }
          }
        }

        // ------------------------------------------
        // 2) ETHEREUMTRANSACTION - decode ethereumData if present
        // ------------------------------------------
        if (txBody.ethereumTransaction) {
          const eth = txBody.ethereumTransaction;
          const ethData =
            eth.ethereumData || eth.ethereum_data || eth.ethereumBytes || null;
          if (ethData && ethData.length > 0 && ethers) {
            const ethInfo = decodeEthereumTx(ethData);
            if (ethInfo && ethInfo.to) {
              const evm = normalizeEvmAddress(ethInfo.to);
              if (CONFIG.watchedEvmAddresses.has(evm)) {
                stats.matches++;
                stats.ethereumTransactions++;

                const txHashHex = bufferToHexMaybe(row.transaction_hash);
                const event = {
                  evmAddress: evm,
                  label: CONFIG.addressLabels[evm] || null,
                  // value is the Ethereum value (wei). Converting to tinybar is not automatic.
                  ethereumValueWei: ethInfo.value,
                  transactionHash: txHashHex,
                  consensusTimestamp: row.consensus_timestamp,
                  senderUsedEvmAddress: true,
                  transactionType: "ETHEREUMTRANSACTION",
                  detectionMethod: "transaction_bytes",
                  memo: txBody.memo || null,
                  ethereumInfo: ethInfo
                };

                // Human-friendly output (note: value shown in wei)
                console.log("\n" + "=".repeat(60));
                console.log("💰 INCOMING TRANSFER DETECTED!");
                console.log("=".repeat(60));
                console.log(
                  `  To: 0x${event.evmAddress}${
                    event.label ? ` (${event.label})` : ""
                  }`
                );
                console.log(
                  `  Ethereum value (wei): ${event.ethereumValueWei}`
                );
                console.log(`  Transaction Hash: ${event.transactionHash}`);
                console.log(`  Timestamp: ${event.consensusTimestamp}`);
                console.log(`  Sender used: EVM Address (ETH tx)`);
                console.log("=".repeat(60));
                console.log(JSON.stringify(event, null, 2));
              }
            }
          } else if (txBody.ethereumTransaction && !ethers) {
            // ethers not installed — optionally fallback to scanning transfer list (if present)
            // some mirror builds will have transfers for ETH txs in the cryptoTransfer section as well
            // nothing else to do here unless you want to attempt simple RLP parsing without ethers
          }
        }
      } // end rows

      process.stdout.write(
        `\r[${new Date().toISOString()}] polls=${stats.polls} scanned=${
          stats.scanned
        } matches=${stats.matches} (${stats.cryptoTransfers} native, ${
          stats.ethereumTransactions
        } EVM)   `
      );
    } catch (err) {
      console.error("DB poll error:", err.message);
    }
  }

  // graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    try {
      await pool.end();
    } catch (_) {}
    process.exit(0);
  });

  // initial poll + loop
  await pollOnce();
  setInterval(pollOnce, CONFIG.pollingIntervalMs);
}

// Start
main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
