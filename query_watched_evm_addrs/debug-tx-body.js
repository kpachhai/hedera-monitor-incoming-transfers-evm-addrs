const { TransferTransaction, Transaction } = require("@hiero-ledger/sdk");

const MIRROR_NODE_URL = "https://testnet.mirrornode.hedera.com";

/**
 * Convert transaction ID from SDK format to Mirror Node format
 * SDK format: 0. 0.6493627@1764172415.508697021
 * Mirror Node format: 0.0.6493627-1764172415-508697021
 */
function formatTransactionIdForMirrorNode(txId) {
  // Handle both formats
  if (txId.includes("@")) {
    // SDK format: 0. 0.6493627@1764172415.508697021
    return txId.replace("@", "-").replace(/\.(?=\d{9}$)/, "-");
  }
  // Already in Mirror Node format
  return txId;
}

async function debugTransaction(transactionId) {
  const formattedTxId = formatTransactionIdForMirrorNode(transactionId);

  console.log("=".repeat(60));
  console.log(`DEBUGGING TRANSACTION`);
  console.log("=".repeat(60));
  console.log(`Original ID: ${transactionId}`);
  console.log(`Formatted ID: ${formattedTxId}`);

  // Fetch the transaction details
  const url = `${MIRROR_NODE_URL}/api/v1/transactions/${formattedTxId}`;
  console.log(`\nFetching: ${url}\n`);

  const response = await fetch(url);
  const data = await response.json();

  if (!data.transactions || data.transactions.length === 0) {
    console.log("No transaction found!");
    console.log("Response:", JSON.stringify(data, null, 2));
    return;
  }

  const tx = data.transactions[0];

  console.log("Transaction fields available:");
  console.log(Object.keys(tx).join(", "));
  console.log();

  console.log("=".repeat(60));
  console.log("TRANSFERS (from Mirror Node - resolved):");
  console.log("=".repeat(60));
  for (const transfer of tx.transfers || []) {
    console.log(`  ${transfer.account}: ${transfer.amount} tinybar`);
  }

  console.log();
  console.log("=".repeat(60));
  console.log("TRANSACTION BODY:");
  console.log("=".repeat(60));

  if (tx.transaction_body) {
    console.log("✅ transaction_body field EXISTS");
    console.log(`Length: ${tx.transaction_body.length} characters`);
    console.log(
      `First 100 chars: ${tx.transaction_body.substring(0, 100)}... `
    );

    // Try to parse it
    try {
      const txBytes = Buffer.from(tx.transaction_body, "base64");
      console.log(`\nDecoded bytes length: ${txBytes.length}`);

      const parsedTx = Transaction.fromBytes(txBytes);
      console.log(`\nParsed transaction type: ${parsedTx.constructor.name}`);

      if (parsedTx instanceof TransferTransaction) {
        console.log("\n✅ Successfully parsed as TransferTransaction");
        console.log("\nHBAR Transfers from parsed transaction:");

        for (const [accountId, amount] of parsedTx.hbarTransfers) {
          console.log(`\n  AccountId object:`);
          console.log(`    toString(): ${accountId.toString()}`);
          console.log(`    num: ${accountId.num?.toString() || "null"}`);
          console.log(
            `    evmAddress: ${accountId.evmAddress?.toString() || "null"}`
          );
          console.log(
            `    aliasKey: ${accountId.aliasKey?.toString() || "null"}`
          );
          console.log(`    shard: ${accountId.shard?.toString() || "null"}`);
          console.log(`    realm: ${accountId.realm?.toString() || "null"}`);
          console.log(
            `  Amount: ${amount.toString()} (${amount.toTinybars()} tinybar)`
          );
        }
      } else {
        console.log(
          `\n⚠️ Not a TransferTransaction, it's a ${parsedTx.constructor.name}`
        );
      }
    } catch (error) {
      console.log(`\n❌ Error parsing transaction_body: ${error.message}`);
      console.log(error.stack);
    }
  } else {
    console.log("❌ transaction_body field is MISSING");
    console.log(
      "\nThis is the problem!  Mirror Node is not returning the transaction body."
    );
    console.log("\nAll transaction data:");
    console.log(JSON.stringify(tx, null, 2));
  }
}

// Get transaction ID from command line
const txId = process.argv[2];

if (!txId) {
  console.log("Usage: node debug-tx-body. js <transaction-id>");
  console.log(
    "Example: node debug-tx-body.js 0. 0.6493627@1764172436. 770583393"
  );
  console.log(
    "     or: node debug-tx-body.js 0.0.6493627-1764172436-770583393"
  );
  process.exit(1);
}

debugTransaction(txId).catch(console.error);
