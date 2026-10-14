import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { getConfig, loadKeypair, getConnection, fromBaseUnits } from "./helpers";

async function main(): Promise<void> {
  const config = getConfig();
  const connection = getConnection();

  if (!config.mintAddress) {
    throw new Error("MINT_ADDRESS is not set in .env.");
  }

  const args = process.argv.slice(2);
  let targetWalletPubkey: PublicKey;

  if (args[0] && args[0].endsWith(".json")) {
    const kp = loadKeypair(args[0]);
    targetWalletPubkey = kp.publicKey;
  } else if (args[0]) {
    targetWalletPubkey = new PublicKey(args[0]);
  } else {
    const admin = loadKeypair(config.adminKeypairPath);
    targetWalletPubkey = admin.publicKey;
  }

  const mint = new PublicKey(config.mintAddress);
  const [salePda] = PublicKey.findProgramAddressSync([Buffer.from("sale"), mint.toBuffer()], new PublicKey("DVGezEfHU5VwEGekdpc3PnUgUpfX2q6FdisG8hoGdF6c"));
  const vaultAta = getAssociatedTokenAddressSync(mint, salePda, true);
  const walletAta = getAssociatedTokenAddressSync(mint, targetWalletPubkey);

  const solBalance = await connection.getBalance(targetWalletPubkey);
  let tokenBalance = "0";
  try {
    const ataAccount = await getAccount(connection, walletAta);
    tokenBalance = fromBaseUnits(BigInt(ataAccount.amount.toString()), config.tokenDecimals);
  } catch (e) {
    tokenBalance = "0 (ATA not initialized yet)";
  }

  let vaultBalance = "0";
  try {
    const vaultAccount = await getAccount(connection, vaultAta);
    vaultBalance = fromBaseUnits(BigInt(vaultAccount.amount.toString()), config.tokenDecimals);
  } catch (e) {
    vaultBalance = "0";
  }

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  LIVE ON-CHAIN TOKEN HOLDINGS (Devnet)");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`  Wallet:             ${targetWalletPubkey.toBase58()}`);
  console.log(`  SOL Balance:        ${solBalance / 1e9} SOL`);
  console.log(`  Token Mint:         ${mint.toBase58()}`);
  console.log(`  Associated ATA:     ${walletAta.toBase58()}`);
  console.log(`  Token Balance:      ${tokenBalance} tokens`);
  console.log("──────────────────────────────────────────────────────────────");
  console.log(`  Sale Vault Balance: ${vaultBalance} tokens remaining in sale`);
  console.log("══════════════════════════════════════════════════════════════");
  console.log("\n🔗 View on Solana Explorer (Devnet):");
  console.log(`  Wallet: https://explorer.solana.com/address/${targetWalletPubkey.toBase58()}?cluster=devnet`);
  console.log(`  ATA:    https://explorer.solana.com/address/${walletAta.toBase58()}?cluster=devnet`);
  console.log(`  Mint:   https://explorer.solana.com/address/${mint.toBase58()}?cluster=devnet\n`);
}

main().catch((err) => {
  console.error("❌ Error fetching balances:", err);
  process.exit(1);
});
