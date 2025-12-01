const {
  Client,
  PrivateKey,
  AccountId,
  TransferTransaction,
  Hbar
} = require("@hiero-ledger/sdk");
require("dotenv").config();

async function sendTestTransfer(recipientEvmAddress) {
  // ===========================================
  // CONFIGURATION - Update these values
  // ===========================================

  const myAccountId = AccountId.fromString(process.env.HEDERA_ACCOUNT_ID);
  const myPrivateKey = PrivateKey.fromStringECDSA(
    process.env.HEDERA_PRIVATE_KEY
  );

  // ===========================================
  // Send transfer
  // ===========================================

  const client = Client.forTestnet();
  client.setOperator(myAccountId, myPrivateKey);

  // Normalize address
  const evmAddress = recipientEvmAddress.toLowerCase().replace("0x", "");

  console.log(`Sending 0.01 HBAR to 0x${evmAddress}...`);

  const transferTx = new TransferTransaction()
    .addHbarTransfer(myAccountId, new Hbar(-0.01))
    .addHbarTransfer(evmAddress, new Hbar(0.01))
    .setTransactionMemo("Test transfer to monitored EVM address");

  const txResponse = await transferTx.execute(client);
  const receipt = await txResponse.getReceipt(client);

  console.log("Transaction ID:", txResponse.transactionId.toString());
  console.log("Status:", receipt.status.toString());

  client.close();

  return txResponse.transactionId.toString();
}

// ===========================================
// MAIN
// ===========================================

async function main() {
  // Get EVM address from command line or use a test address
  const evmAddress = process.argv[2];

  if (!evmAddress) {
    console.log("Usage: node send-test-transfer. js <evm-address>");
    console.log(
      "Example: node send-test-transfer.js 0x8f31e9fa14266c5da7f63bfc96811e08b7c09183"
    );
    process.exit(1);
  }

  await sendTestTransfer(evmAddress);
}

main().catch(console.error);
