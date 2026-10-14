import { PublicKey, Keypair } from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  setAuthority,
  AuthorityType,
} from "@solana/spl-token";
import { getConfig, loadKeypair, getConnection, toBaseUnits, fromBaseUnits } from "./helpers";

/**
 * create-token.ts
 *
 * Creates a new SPL token mint, mints the total supply to the admin's
 * associated token account, and optionally revokes the mint authority
 * to make the supply permanently fixed.
 *
 * Usage:
 *   npx ts-node scripts/create-token.ts
 *
 * Prerequisites:
 *   - .env file with ADMIN_KEYPAIR_PATH, TOKEN_DECIMALS, TOTAL_SUPPLY,
 *     REVOKE_MINT_AUTHORITY, and SOLANA_CLUSTER configured.
 *   - Admin keypair must have enough SOL for transaction fees.
 */
async function main(): Promise<void> {
  console.log("🚀 Starting token creation...\n");

  // 1. Load configuration
  const config = getConfig();
  const connection = getConnection();

  // 2. Load admin keypair
  console.log(`📂 Loading admin keypair from: ${config.adminKeypairPath}`);
  const admin: Keypair = loadKeypair(config.adminKeypairPath);
  console.log(`👤 Admin public key: ${admin.publicKey.toBase58()}`);

  // Check admin balance
  const balance = await connection.getBalance(admin.publicKey);
  console.log(`💰 Admin balance: ${balance / 1e9} SOL\n`);
  if (balance < 0.01 * 1e9) {
    throw new Error(
      "Admin account has insufficient SOL. Please fund the account first.\n" +
      "  For devnet: solana airdrop 2 " + admin.publicKey.toBase58()
    );
  }

  // 3. Create the mint (no freeze authority)
  console.log(`🏭 Creating mint with ${config.tokenDecimals} decimals...`);
  const mint: PublicKey = await createMint(
    connection,
    admin,                    // payer
    admin.publicKey,          // mint authority
    null,                     // freeze authority (none)
    config.tokenDecimals      // decimals
  );
  console.log(`✅ Mint created: ${mint.toBase58()}\n`);

  // 4. Create the admin's associated token account (ATA)
  console.log("📦 Creating admin's associated token account...");
  const adminAta = await getOrCreateAssociatedTokenAccount(
    connection,
    admin,                    // payer
    mint,                     // mint
    admin.publicKey            // owner
  );
  console.log(`✅ Admin ATA: ${adminAta.address.toBase58()}\n`);

  // 5. Mint the total supply to admin's ATA
  const totalSupplyBaseUnits = toBaseUnits(config.totalSupply, config.tokenDecimals);
  console.log(
    `🪙 Minting ${config.totalSupply} tokens ` +
    `(${totalSupplyBaseUnits.toString()} base units) to admin ATA...`
  );
  const mintTxSig = await mintTo(
    connection,
    admin,                    // payer
    mint,                     // mint
    adminAta.address,         // destination
    admin,                    // mint authority
    totalSupplyBaseUnits      // amount in base units
  );
  console.log(`✅ Mint transaction: ${mintTxSig}\n`);

  // 6. Optionally revoke mint authority
  if (config.revokeMintAuthority) {
    console.log("🔒 Revoking mint authority (supply is now permanently fixed)...");
    const revokeTxSig = await setAuthority(
      connection,
      admin,                  // payer
      mint,                   // account (the mint)
      admin,                  // current authority
      AuthorityType.MintTokens, // authority type
      null                    // new authority (null = revoke)
    );
    console.log(`✅ Mint authority revoked. Tx: ${revokeTxSig}\n`);
  } else {
    console.log("⚠️  Mint authority NOT revoked. Admin can still mint more tokens.\n");
  }

  // 7. Print summary
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  TOKEN CREATION COMPLETE");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Mint Address:      ${mint.toBase58()}`);
  console.log(`  Admin Pubkey:      ${admin.publicKey.toBase58()}`);
  console.log(`  Admin ATA:         ${adminAta.address.toBase58()}`);
  console.log(`  Total Supply:      ${fromBaseUnits(totalSupplyBaseUnits, config.tokenDecimals)} tokens`);
  console.log(`  Decimals:          ${config.tokenDecimals}`);
  console.log(`  Mint Revoked:      ${config.revokeMintAuthority ? "Yes ✅" : "No ⚠️"}`);
  console.log(`  Cluster:           ${config.solanaCluster}`);
  console.log("═══════════════════════════════════════════════════════════");
  console.log("");
  console.log("👉 Next step: Add the following to your .env file:");
  console.log(`   MINT_ADDRESS=${mint.toBase58()}`);
  console.log("");
}

main().catch((err) => {
  console.error("❌ Error creating token:", err);
  process.exit(1);
});
