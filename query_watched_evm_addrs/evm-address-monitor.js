const { PrivateKey } = require("@hiero-ledger/sdk");

// ===========================================
// CONFIGURATION
// ===========================================

const CONFIG = {
  mirrorNodeUrl: "https://testnet.mirrornode.hedera.com",
  pollingIntervalMs: 5000,

  // Your EVM addresses to monitor
  watchedEvmAddresses: new Set(["8f31e9fa14266c5da7f63bfc96811e08b7c09183"]),

  addressLabels: {
    "8f31e9fa14266c5da7f63bfc96811e08b7c09183": "Wallet A"
  },

  // Transaction types to monitor
  // CRYPTOTRANSFER = native Hedera transfer
  // ETHEREUMTRANSACTION = EVM-based transfer (MetaMask, web3. js, etc.)
  transactionTypes: ["CRYPTOTRANSFER", "ETHEREUMTRANSACTION"]
};

// ===========================================
// UTILITY FUNCTIONS
// ===========================================

function normalizeEvmAddress(address) {
  return address.toLowerCase().replace("0x", "");
}

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

function getAddressLabel(evmAddress) {
  const normalized = normalizeEvmAddress(evmAddress);
  return CONFIG.addressLabels[normalized] || null;
}

// ===========================================
// MIRROR NODE API
// ===========================================

async function fetchAccountByEvmAddress(evmAddress) {
  const normalized = normalizeEvmAddress(evmAddress);
  const url = `${CONFIG.mirrorNodeUrl}/api/v1/accounts/0.0.${normalized}`;

  const response = await fetch(url);

  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new Error(`Mirror Node API error: ${response.status}`);
  }

  return response.json();
}

/**
 * Fetch transactions for an account - supports multiple transaction types
 * @param {string} accountId - The account ID (e.g., "0.0.12345")
 * @param {object} params - Query parameters
 * @returns {Promise<object>} - Transaction data
 */
async function fetchAccountTransactions(accountId, params = {}) {
  const allTransactions = [];

  // Fetch each transaction type separately
  for (const txType of CONFIG.transactionTypes) {
    const queryParams = new URLSearchParams({
      limit: params.limit || 50,
      order: "desc",
      transactiontype: txType
    });

    if (params.timestamp) {
      queryParams.set("timestamp", `gt:${params.timestamp}`);
    }

    const url = `${CONFIG.mirrorNodeUrl}/api/v1/transactions?account.id=${accountId}&${queryParams}`;

    try {
      const response = await fetch(url);

      if (!response.ok) {
        console.error(
          `Error fetching ${txType} transactions: ${response.status}`
        );
        continue;
      }

      const data = await response.json();

      if (data.transactions && data.transactions.length > 0) {
        // Add transaction type info to each transaction
        for (const tx of data.transactions) {
          tx._txType = txType;
          allTransactions.push(tx);
        }
      }
    } catch (error) {
      console.error(`Error fetching ${txType} transactions:`, error.message);
    }
  }

  // Sort all transactions by consensus_timestamp (newest first)
  allTransactions.sort((a, b) => {
    const tsA = parseFloat(a.consensus_timestamp);
    const tsB = parseFloat(b.consensus_timestamp);
    return tsB - tsA;
  });

  return { transactions: allTransactions };
}

/**
 * Get transaction type display name
 */
function getTransactionTypeName(tx) {
  // Use the name field if available, otherwise use our tracked type
  return tx.name || tx._txType || "UNKNOWN";
}

/**
 * Check if a transaction is an EVM transaction
 */
function isEvmTransaction(tx) {
  const name = tx.name || tx._txType || "";
  return name === "ETHEREUMTRANSACTION";
}

// ===========================================
// EVM ADDRESS MONITOR - Direct Approach
// ===========================================

class EvmAddressMonitor {
  constructor(options = {}) {
    this.onTransferReceived = options.onTransferReceived || this.defaultHandler;
    this.onAccountCreated = options.onAccountCreated || (() => {});
    this.onError = options.onError || console.error;
    this.isRunning = false;

    // Track account state
    this.accountState = new Map(); // evmAddress -> { entityId, lastBalance, lastTimestamp }

    this.stats = {
      totalPolls: 0,
      newAccountsDetected: 0,
      transfersDetected: 0,
      cryptoTransfers: 0,
      ethereumTransactions: 0
    };
  }

  defaultHandler(transfer) {
    console.log("\n" + "=".repeat(60));
    console.log("💰 INCOMING TRANSFER DETECTED!");
    console.log("=".repeat(60));
    console.log(
      `  To: 0x${transfer.evmAddress} (${transfer.label || "No label"})`
    );
    console.log(`  Entity ID: ${transfer.entityId}`);
    console.log(`  Amount: ${transfer.amountHbar}`);
    console.log(`  Transaction Type: ${transfer.transactionType}`);
    console.log(`  Transaction: ${transfer.transactionId}`);
    console.log("=".repeat(60));
  }

  /**
   * Check a single EVM address for account existence and new transfers
   */
  async checkEvmAddress(evmAddress) {
    const normalized = normalizeEvmAddress(evmAddress);
    const label = getAddressLabel(normalized);

    try {
      const account = await fetchAccountByEvmAddress(normalized);

      if (!account) {
        // Account doesn't exist yet
        if (this.accountState.has(normalized)) {
          console.log(`⚠️ Account 0x${normalized} no longer exists? `);
        }
        return;
      }

      const currentState = this.accountState.get(normalized);
      const entityId = account.account;
      const balance = account.balance.balance;

      if (!currentState) {
        // First time seeing this account - it was just created!
        console.log(`\n🆕 NEW ACCOUNT DETECTED! `);
        console.log(`   EVM Address: 0x${normalized} (${label || "No label"})`);
        console.log(`   Entity ID: ${entityId}`);
        console.log(`   Balance: ${balance / 100_000_000} ℏ`);

        this.accountState.set(normalized, {
          entityId,
          lastBalance: balance,
          lastTimestamp: null
        });

        this.stats.newAccountsDetected++;

        this.onAccountCreated({
          evmAddress: normalized,
          label,
          entityId,
          balance: `${balance / 100_000_000} ℏ`
        });

        // Fetch recent transactions for this new account
        await this.fetchNewTransfers(normalized, entityId, null);
      } else if (balance !== currentState.lastBalance) {
        // Balance changed - fetch new transfers
        console.log(`\n📊 Balance change detected for 0x${normalized}`);
        console.log(`   Old: ${currentState.lastBalance / 100_000_000} ℏ`);
        console.log(`   New: ${balance / 100_000_000} ℏ`);

        await this.fetchNewTransfers(
          normalized,
          entityId,
          currentState.lastTimestamp
        );

        // Update state
        currentState.lastBalance = balance;
      }
    } catch (error) {
      console.error(`Error checking 0x${normalized}:`, error.message);
    }
  }

  /**
   * Fetch and report new transfers for an account
   * Handles both CRYPTOTRANSFER and ETHEREUMTRANSACTION types
   */
  async fetchNewTransfers(evmAddress, entityId, sinceTimestamp) {
    try {
      const params = {};
      if (sinceTimestamp) {
        params.timestamp = sinceTimestamp;
      }

      const data = await fetchAccountTransactions(entityId, params);

      if (!data.transactions || data.transactions.length === 0) {
        return;
      }

      const label = getAddressLabel(evmAddress);

      // Process transactions (newest first, so reverse for chronological order)
      const transactions = [...data.transactions].reverse();

      for (const tx of transactions) {
        // Determine the transfer amount based on transaction type
        let incomingTransfer = null;
        const txType = getTransactionTypeName(tx);
        const isEvm = isEvmTransaction(tx);

        // Find the transfer to this account
        // For both CRYPTOTRANSFER and ETHEREUMTRANSACTION, the transfers array contains the HBAR movements
        if (tx.transfers && tx.transfers.length > 0) {
          incomingTransfer = tx.transfers.find(
            (t) => t.account === entityId && t.amount > 0
          );
        }

        if (incomingTransfer) {
          this.stats.transfersDetected++;

          if (isEvm) {
            this.stats.ethereumTransactions++;
          } else {
            this.stats.cryptoTransfers++;
          }

          // Update last timestamp
          const state = this.accountState.get(evmAddress);
          if (state) {
            state.lastTimestamp = tx.consensus_timestamp;
          }

          // Build transfer info
          const transferInfo = {
            evmAddress,
            label,
            entityId,
            amount: `${incomingTransfer.amount} tinybar`,
            amountHbar: `${incomingTransfer.amount / 100_000_000} ℏ`,
            transactionId: tx.transaction_id,
            transactionType: txType,
            isEvmTransaction: isEvm,
            consensusTimestamp: tx.consensus_timestamp,
            balance: `${state?.lastBalance / 100_000_000} ℏ`,
            memo: tx.memo_base64
              ? Buffer.from(tx.memo_base64, "base64").toString()
              : null
          };

          // For ETHEREUMTRANSACTION, add additional EVM-specific info if available
          if (isEvm) {
            transferInfo.ethereumData = {
              hash: tx.transaction_hash || null
              // The ethereum_transaction field may contain additional details
              // when fetching individual transaction details
            };
          }

          this.onTransferReceived(transferInfo);
        }
      }
    } catch (error) {
      console.error(`Error fetching transfers for ${entityId}:`, error.message);
    }
  }

  /**
   * Poll all watched addresses
   */
  async poll() {
    this.stats.totalPolls++;

    const addresses = Array.from(CONFIG.watchedEvmAddresses);

    // Process in parallel with a small batch size to avoid rate limits
    const batchSize = 5;
    for (let i = 0; i < addresses.length; i += batchSize) {
      const batch = addresses.slice(i, i + batchSize);
      await Promise.all(batch.map((addr) => this.checkEvmAddress(addr)));
    }

    process.stdout.write(
      `\r[${new Date().toISOString()}] Poll #${this.stats.totalPolls} - ` +
        `Watching ${addresses.length} addresses, ` +
        `${this.stats.newAccountsDetected} new accounts, ` +
        `${this.stats.transfersDetected} transfers ` +
        `(${this.stats.cryptoTransfers} native, ${this.stats.ethereumTransactions} EVM)   `
    );
  }

  async start() {
    console.log("=".repeat(60));
    console.log("EVM ADDRESS MONITOR (Direct Query Approach)");
    console.log("=".repeat(60));
    console.log(`Watching ${CONFIG.watchedEvmAddresses.size} EVM addresses`);
    console.log(`Polling interval: ${CONFIG.pollingIntervalMs}ms`);
    console.log(`Transaction types: ${CONFIG.transactionTypes.join(", ")}`);
    console.log();
    console.log("This approach queries each watched EVM address directly,");
    console.log("which scales well for a known set of addresses.");
    console.log();
    console.log("Supported transaction types:");
    console.log("  • CRYPTOTRANSFER - Native Hedera HBAR transfers");
    console.log(
      "  • ETHEREUMTRANSACTION - EVM-based transfers (MetaMask, web3.js)"
    );
    console.log();

    this.isRunning = true;

    // Initial poll
    await this.poll();

    // Start polling loop
    this.pollInterval = setInterval(async () => {
      if (this.isRunning) {
        await this.poll();
      }
    }, CONFIG.pollingIntervalMs);

    console.log("\nMonitor started. Watching for incoming transfers.. .\n");
  }

  stop() {
    this.isRunning = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
    console.log("\n\nMonitor stopped.");
    console.log(
      `Final stats: ${this.stats.totalPolls} polls, ` +
        `${this.stats.newAccountsDetected} new accounts, ` +
        `${this.stats.transfersDetected} transfers ` +
        `(${this.stats.cryptoTransfers} native, ${this.stats.ethereumTransactions} EVM)`
    );
  }
}

// ===========================================
// MAIN
// ===========================================

async function main() {
  console.log("=".repeat(60));
  console.log("GENERATING TEST ADDRESSES TO WATCH");
  console.log("=".repeat(60));

  for (let i = 0; i < 3; i++) {
    const privateKey = PrivateKey.generateECDSA();
    const evmAddress = privateKey.publicKey.toEvmAddress();
    addWatchedAddress(evmAddress, `Test Wallet ${i + 1}`);
  }

  console.log();

  const monitor = new EvmAddressMonitor({
    onTransferReceived: (transfer) => {
      console.log("\n\n" + "🎉".repeat(30));
      console.log("INCOMING TRANSFER DETECTED!");
      console.log("🎉".repeat(30));
      console.log(JSON.stringify(transfer, null, 2));

      if (transfer.isEvmTransaction) {
        console.log(
          "\n📱 This transfer came through the Hedera EVM (e.g., MetaMask)"
        );
      } else {
        console.log("\n🔷 This is a native Hedera CRYPTOTRANSFER");
      }
      console.log();
    },

    onAccountCreated: (account) => {
      console.log("\n\n" + "🆕".repeat(30));
      console.log("NEW ACCOUNT CREATED (Lazy-Create)!");
      console.log("🆕".repeat(30));
      console.log(JSON.stringify(account, null, 2));
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
