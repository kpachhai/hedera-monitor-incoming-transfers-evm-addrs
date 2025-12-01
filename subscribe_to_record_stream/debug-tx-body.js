const { Transaction } = require("@hiero-ledger/sdk");
require("dotenv").config();

const MIRROR_NODE_URL = process.env.MIRROR_NODE_URL || "http://localhost:8081";

function formatTxIdForMirror(txId) {
  // Convert SDK 0.0.1012@1764... => 0.0.1012-1764...-nnn
  if (!txId) return txId;
  if (txId.includes("@")) {
    const parts = txId.split("@");
    const left = parts[0];
    const right = parts[1];
    // replace last dot before 9 digits with -
    return `${left}-${right.replace(/\.(?=\d{9}$)/, "-")}`;
  }
  return txId;
}

async function debugTransaction(txIdInput) {
  const txId = formatTxIdForMirror(txIdInput);
  console.log("DEBUG", txIdInput, "->", txId);
  const url = `${MIRROR_NODE_URL}/api/v1/transactions/${txId}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (!data.transactions || data.transactions.length === 0) {
    console.log(
      "No transactions found. Response:",
      JSON.stringify(data, null, 2)
    );
    return;
  }
  const tx = data.transactions[0];
  console.log("Fields:", Object.keys(tx).join(", "));
  console.log("Transfers:", JSON.stringify(tx.transfers || [], null, 2));
  // Try transaction_body first
  if (tx.transaction_body) {
    console.log(
      "transaction_body exists (base64) length:",
      tx.transaction_body.length
    );
    try {
      const txBytes = Buffer.from(tx.transaction_body, "base64");
      const parsed = Transaction.fromBytes(txBytes);
      console.log("Parsed tx type:", parsed.constructor.name);
      if (parsed.hbarTransfers) {
        for (const [aid, amount] of parsed.hbarTransfers) {
          console.log(
            "Parsed transfer: account:",
            aid.toString(),
            "evmAddress:",
            aid.evmAddress ? aid.evmAddress.toString() : null,
            "amount:",
            amount.toString()
          );
        }
      }
    } catch (e) {
      console.log("Error parsing transaction_body:", e.message);
    }
  } else if (tx.bytes) {
    // some mirror builds expose 'bytes' or 'transaction_bytes' base64
    console.log(
      "tx.bytes field exists; length:",
      tx.bytes ? tx.bytes.length : 0
    );
    try {
      const txBytes = Buffer.from(tx.bytes, "base64");
      const parsed = Transaction.fromBytes(txBytes);
      console.log("Parsed tx type from tx.bytes:", parsed.constructor.name);
    } catch (e) {
      console.log("Error parsing tx.bytes:", e.message);
    }
  } else {
    console.log(
      "No transaction_body or bytes field returned by Mirror Node REST for this tx."
    );
  }
}

const txArg = process.argv[2];
if (!txArg) {
  console.log("Usage: node debug-tx-body.js <txId>");
  process.exit(1);
}
debugTransaction(txArg).catch((e) => {
  console.error(e);
  process.exit(1);
});
