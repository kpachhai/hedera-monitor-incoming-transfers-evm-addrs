const { TransferTransaction, Transaction } = require("@hiero-ledger/sdk");

// ===========================================
// CONFIGURATION
// ===========================================

const CONFIG = {
  // Mirror Node URL (change to mainnet for production)
  mirrorNodeUrl: "https://testnet.mirrornode.hedera.com",

  // Polling interval in milliseconds
  pollingIntervalMs: 3000,

  // How far back to start (in seconds) - default 5 seconds
  lookbackSeconds: 5,

  // Your EVM addresses to monitor (add your offline-generated addresses here)
  watchedEvmAddresses: new Set([
    "8f31e9fa14266c5da7f63bfc96811e08b7c09183"
    // Add more addresses here (without 0x prefix, lowercase)
  ]),

  // Optional: Map EVM addresses to labels for easier identification
  addressLabels: {
    "8f31e9fa14266c5da7f63bfc96811e08b7c09183": "Wallet A"
    // Add more labels here
  },

  // Enable debug logging
  debug: false
};

// ===========================================
// UTILITY FUNCTIONS
// ===========================================

function log(...args) {
  if (CONFIG.debug) {
    console.log(new Date().toISOString(), ...args);
  }
}

/**
 * Get timestamp from X seconds ago in Hedera format
 */
function getTimestampSecondsAgo(seconds) {
  const now = Date.now();
  const past = now - seconds * 1000;
  const pastSeconds = Math.floor(past / 1000);
  const nanos = (past % 1000) * 1000000;
  return `${pastSeconds}.${nanos.toString().padStart(9, "0")}`;
}

/**
 * Normalize EVM address to lowercase without 0x prefix
 */
function normalizeEvmAddress(address) {
  return address.toLowerCase().replace("0x", "");
}

/**
 * Add an EVM address to the watch list
 */
function addWatchedAddress(evmAddress, label = null) {
  const normalized = normalizeEvmAddress(evmAddress);
  CONFIG.watchedEvmAddresses.add(normalized);
  if (label) {
    CONFIG.addressLabels[normalized] = label;
  }
  console.log(
    `Added address to watch list: 0x${normalized}${label ? ` (${label})` : ""}`
  );
}

/**
 * Check if an address is in our watch list
 */
function isWatchedAddress(evmAddress) {
  if (!evmAddress) return false;
  return CONFIG.watchedEvmAddresses.has(normalizeEvmAddress(evmAddress));
}

/**
 * Get label for an address
 */
function getAddressLabel(evmAddress) {
  const normalized = normalizeEvmAddress(evmAddress);
  return CONFIG.addressLabels[normalized] || null;
}

// ===========================================
// TRANSACTION PARSING
// ===========================================

/**
 * Parse transaction bytes and extract transfer details
 */
function parseTransactionBytes(txBytesBase64) {
  try {
    const txBytes = Buffer.from(txBytesBase64, "base64");
    const tx = Transaction.fromBytes(txBytes);

    if (!(tx instanceof TransferTransaction)) {
      return { success: false, reason: "Not a transfer transaction" };
    }

    const transfers = [];

    for (const [accountId, amount] of tx.hbarTransfers) {
      const transfer = {
        amount: amount.toString(),
        amountTinybar: amount.toTinybars().toString(),
        isCredit: amount.toTinybars() > 0
      };

      if (accountId.evmAddress) {
        transfer.type = "EVM_ADDRESS";
        transfer.evmAddress = accountId.evmAddress.toString();
        transfer.isWatched = isWatchedAddress(transfer.evmAddress);
        transfer.label = getAddressLabel(transfer.evmAddress);
      } else if (accountId.aliasKey) {
        transfer.type = "PUBLIC_KEY_ALIAS";
        transfer.aliasKey = accountId.aliasKey.toString();
      } else {
        transfer.type = "ENTITY_ID";
        transfer.entityId = accountId.toString();
      }

      transfers.push(transfer);
    }

    return {
      success: true,
      transfers,
      memo: tx.transactionMemo
    };
  } catch (error) {
    return { success: false, reason: error.message };
  }
}

/**
 * Extract watched address transfers from parsed transaction
 */
function extractWatchedTransfers(parsedTx) {
  if (!parsedTx.success) return [];
  return parsedTx.transfers.filter((t) => t.isWatched && t.isCredit);
}

// ===========================================
// MIRROR NODE API
// ===========================================

async function fetchTransactions(params = {}) {
  const queryParams = new URLSearchParams({
    limit: params.limit || 100,
    order: "asc",
    transactiontype: "CRYPTOTRANSFER"
  });

  if (params.timestamp) {
    queryParams.set("timestamp", `gt:${params.timestamp}`);
  }

  const url = `${CONFIG.mirrorNodeUrl}/api/v1/transactions?${queryParams}`;

  log("Fetching:", url);

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Mirror Node API error: ${response.status}`);
  }

  return response.json();
}

async function fetchTransactionDetails(transactionId) {
  const url = `${CONFIG.mirrorNodeUrl}/api/v1/transactions/${transactionId}`;

  log("Fetching transaction details:", url);

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Mirror Node API error: ${response.status}`);
  }

  return response.json();
}

async function fetchAccountByEvmAddress(evmAddress) {
  const normalized = normalizeEvmAddress(evmAddress);
  const url = `${CONFIG.mirrorNodeUrl}/api/v1/accounts/0.0.${normalized}`;

  log("Fetching account by EVM address:", url);

  const response = await fetch(url);

  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new Error(`Mirror Node API error: ${response.status}`);
  }

  return response.json();
}

// ===========================================
// TRANSACTION MONITOR
// ===========================================

class EvmAddressMonitor {
  constructor(options = {}) {
    this.lastTimestamp = options.startTimestamp || null;
    this.onTransferReceived = options.onTransferReceived || this.defaultHandler;
    this.onError = options.onError || console.error;
    this.isRunning = false;
    this.processedTxIds = new Set();

    // Cache: EVM address -> Entity ID mapping (updated dynamically)
    this.evmToEntityCache = new Map();
    this.entityToEvmCache = new Map();

    this.stats = {
      totalProcessed: 0,
      matchesFound: 0
    };
  }

  defaultHandler(transfer) {
    console.log("\n" + "=".repeat(60));
    console.log("💰 INCOMING TRANSFER DETECTED!");
    console.log("=".repeat(60));
    console.log(
      `  To: 0x${transfer.evmAddress}${
        transfer.label ? ` (${transfer.label})` : ""
      }`
    );
    console.log(`  Amount: ${transfer.amount}`);
    console.log(`  Transaction ID: ${transfer.transactionId}`);
    console.log(`  Timestamp: ${transfer.consensusTimestamp}`);
    console.log(
      `  Sender used: ${
        transfer.senderUsedEvmAddress ? "EVM Address" : "Entity ID"
      }`
    );
    if (transfer.resolvedEntityId) {
      console.log(`  Resolved Entity ID: ${transfer.resolvedEntityId}`);
    }
    console.log("=".repeat(60));
  }

  async buildEntityCache() {
    console.log("Building EVM -> Entity ID cache for existing accounts...");

    for (const evmAddress of CONFIG.watchedEvmAddresses) {
      try {
        const account = await fetchAccountByEvmAddress(evmAddress);
        if (account) {
          this.evmToEntityCache.set(evmAddress, account.account);
          this.entityToEvmCache.set(account.account, evmAddress);
          console.log(`  0x${evmAddress} -> ${account.account}`);
        } else {
          console.log(
            `  0x${evmAddress} -> (not yet created - will detect via tx body parsing)`
          );
        }
      } catch (error) {
        console.error(`  Error fetching 0x${evmAddress}:`, error.message);
      }
    }

    console.log("Cache built.\n");
  }

  /**
   * Update cache when we discover a new entity ID for an EVM address
   */
  updateCache(evmAddress, entityId) {
    const normalized = normalizeEvmAddress(evmAddress);
    if (!this.evmToEntityCache.has(normalized)) {
      this.evmToEntityCache.set(normalized, entityId);
      this.entityToEvmCache.set(entityId, normalized);
      console.log(`\n📝 Cache updated: 0x${normalized} -> ${entityId}`);
    }
  }

  /**
   * Check if a transaction involves any of our watched addresses
   * using the resolved entity IDs from Mirror Node (for already-existing accounts)
   */
  checkTransfersForWatchedEntityIds(transfers) {
    const matches = [];

    for (const transfer of transfers || []) {
      const evmAddress = this.entityToEvmCache.get(transfer.account);
      if (evmAddress && transfer.amount > 0) {
        matches.push({
          entityId: transfer.account,
          evmAddress: evmAddress,
          amount: transfer.amount,
          label: getAddressLabel(evmAddress),
          source: "entity_cache"
        });
      }
    }

    return matches;
  }

  /**
   * Process a single transaction - now fetches transaction body for ALL transactions
   * to detect transfers to not-yet-created EVM addresses
   */
  async processTransaction(tx) {
    const txId = tx.transaction_id;

    if (this.processedTxIds.has(txId)) {
      return;
    }
    this.processedTxIds.add(txId);
    this.stats.totalProcessed++;

    // Limit cache size
    if (this.processedTxIds.size > 10000) {
      const entries = [...this.processedTxIds];
      this.processedTxIds = new Set(entries.slice(-5000));
    }

    // APPROACH 1: Quick check using entity ID cache (for existing accounts)
    const entityMatches = this.checkTransfersForWatchedEntityIds(tx.transfers);

    // APPROACH 2: Parse transaction body to find EVM address transfers
    // This is essential for detecting transfers to not-yet-created accounts!
    let txBodyMatches = [];
    let parsedTransfers = null;

    try {
      const details = await fetchTransactionDetails(txId);

      if (details.transactions && details.transactions.length > 0) {
        const txData = details.transactions[0];

        if (txData.transaction_body) {
          const parsed = parseTransactionBytes(txData.transaction_body);

          if (parsed.success) {
            parsedTransfers = parsed.transfers;

            // Find any transfers to watched EVM addresses
            const watchedEvmTransfers = extractWatchedTransfers(parsed);

            for (const evmTransfer of watchedEvmTransfers) {
              // Check if we already found this via entity cache
              const alreadyFound = entityMatches.some(
                (m) =>
                  normalizeEvmAddress(m.evmAddress) ===
                  normalizeEvmAddress(evmTransfer.evmAddress)
              );

              if (!alreadyFound) {
                // This is a NEW match - likely a lazy-created account!
                // Try to find the resolved entity ID from the Mirror Node transfer list
                let resolvedEntityId = null;

                // The new account should be in the transfers with a positive amount
                // and NOT be the sender or fee accounts
                for (const mirrorTransfer of tx.transfers || []) {
                  // Skip known accounts (sender, fee accounts, etc.)
                  if (
                    mirrorTransfer.amount > 0 &&
                    !this.entityToEvmCache.has(mirrorTransfer.account) &&
                    !["0. 0.98", "0.0.800", "0.0.801"].includes(
                      mirrorTransfer.account
                    )
                  ) {
                    // This might be our newly created account
                    // Verify by checking if the amount matches
                    const amountMatch =
                      mirrorTransfer.amount.toString() ===
                      evmTransfer.amountTinybar;
                    if (amountMatch) {
                      resolvedEntityId = mirrorTransfer.account;
                      // Update our cache for future lookups
                      this.updateCache(
                        evmTransfer.evmAddress,
                        resolvedEntityId
                      );
                      break;
                    }
                  }
                }

                txBodyMatches.push({
                  evmAddress: evmTransfer.evmAddress,
                  label: evmTransfer.label,
                  amount: evmTransfer.amountTinybar,
                  resolvedEntityId: resolvedEntityId,
                  source: "tx_body_parse"
                });
              }
            }
          }
        }
      }
    } catch (error) {
      log(`Error fetching details for ${txId}: ${error.message}`);
    }

    // Combine matches from both approaches
    const allMatches = [...entityMatches, ...txBodyMatches];

    if (allMatches.length === 0) {
      return; // No matches
    }

    // Match found!
    console.log(`\n🔍 Match found: ${txId} (${allMatches.length} transfer(s))`);
    this.stats.matchesFound += allMatches.length;

    // Report all matches
    for (const match of allMatches) {
      // Determine if sender used EVM address
      let usedEvmForThis = false;
      if (parsedTransfers) {
        usedEvmForThis = parsedTransfers.some(
          (t) =>
            t.type === "EVM_ADDRESS" &&
            normalizeEvmAddress(t.evmAddress) ===
              normalizeEvmAddress(match.evmAddress) &&
            t.isCredit
        );
      }

      this.onTransferReceived({
        evmAddress: match.evmAddress,
        label: match.label,
        amount: `${match.amount} tinybar`,
        amountHbar: `${match.amount / 100_000_000} ℏ`,
        transactionId: txId,
        consensusTimestamp: tx.consensus_timestamp,
        resolvedEntityId: match.resolvedEntityId || match.entityId,
        senderUsedEvmAddress: usedEvmForThis,
        detectionMethod: match.source,
        memo: tx.memo_base64
          ? Buffer.from(tx.memo_base64, "base64").toString()
          : null
      });
    }
  }

  async poll() {
    try {
      const params = {};
      if (this.lastTimestamp) {
        params.timestamp = this.lastTimestamp;
      }

      const data = await fetchTransactions(params);

      if (data.transactions && data.transactions.length > 0) {
        const count = data.transactions.length;
        process.stdout.write(
          `\r[${new Date().toISOString()}] Processing ${count} transactions (total: ${
            this.stats.totalProcessed
          }, matches: ${this.stats.matchesFound})   `
        );

        for (const tx of data.transactions) {
          await this.processTransaction(tx);
          this.lastTimestamp = tx.consensus_timestamp;
        }
      }
    } catch (error) {
      this.onError(error);
    }
  }

  async start() {
    console.log("=".repeat(60));
    console.log("EVM ADDRESS MONITOR");
    console.log("=".repeat(60));
    console.log(`Watching ${CONFIG.watchedEvmAddresses.size} addresses`);
    console.log(`Polling interval: ${CONFIG.pollingIntervalMs}ms`);
    console.log();

    // Build the entity cache first
    await this.buildEntityCache();

    // Set starting timestamp if not provided
    if (!this.lastTimestamp) {
      this.lastTimestamp = getTimestampSecondsAgo(CONFIG.lookbackSeconds);
      console.log(
        `Starting from ${CONFIG.lookbackSeconds} seconds ago: ${this.lastTimestamp}`
      );
    } else {
      console.log(`Starting from provided timestamp: ${this.lastTimestamp}`);
    }

    this.isRunning = true;

    console.log("\nMonitor started. Watching for incoming transfers...\n");

    // Initial poll
    await this.poll();

    // Start polling loop
    this.pollInterval = setInterval(async () => {
      if (this.isRunning) {
        await this.poll();
      }
    }, CONFIG.pollingIntervalMs);
  }

  stop() {
    this.isRunning = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
    console.log("\nMonitor stopped.");
    console.log(
      `Final stats: ${this.stats.totalProcessed} transactions processed, ${this.stats.matchesFound} matches found`
    );
  }
}

// ===========================================
// MAIN
// ===========================================

async function main() {
  const { PrivateKey } = require("@hiero-ledger/sdk");

  console.log("=".repeat(60));
  console.log("GENERATING TEST ADDRESSES TO WATCH");
  console.log("=".repeat(60));

  for (let i = 0; i < 3; i++) {
    const privateKey = PrivateKey.generateECDSA();
    const evmAddress = privateKey.publicKey.toEvmAddress();
    addWatchedAddress(evmAddress, `Test Wallet ${i + 1}`);
  }

  console.log();

  // Create and start the monitor
  const monitor = new EvmAddressMonitor({
    onTransferReceived: (transfer) => {
      console.log("\n\n" + "🎉".repeat(30));
      console.log("INCOMING TRANSFER TO WATCHED EVM ADDRESS!");
      console.log("🎉".repeat(30));
      console.log(JSON.stringify(transfer, null, 2));
      console.log();
    },

    onError: (error) => {
      console.error("\nMonitor error:", error.message);
    }
  });

  await monitor.start();

  process.on("SIGINT", () => {
    console.log("\n\nShutting down.. .");
    monitor.stop();
    process.exit(0);
  });
}

main().catch(console.error);
