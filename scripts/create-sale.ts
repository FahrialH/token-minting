import * as fs from "fs";
import * as path from "path";
import { PublicKey, SystemProgram, Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Program, AnchorProvider, Wallet, BN, Idl } from "@coral-xyz/anchor";
import { getConfig, loadKeypair, getConnection, confirmTx, toBaseUnits, fromBaseUnits } from "./helpers";

/**
 * create-sale.ts
 *
 * Initializes a fixed-price token sale on-chain by calling the
 * `initialize_sale` instruction on the deployed Anchor program.
 *
 * Usage:
 *   npx ts-node scripts/create-sale.ts
 *
 * Prerequisites:
 *   - .env file with MINT_ADDRESS set (from create-token.ts output)
 *   - Anchor program built and deployed
 *   - Admin keypair funded with SOL
 */

/**
 * Loads the Anchor IDL from the built program artifacts.
 * Searches in the standard Anchor build output directory.
 */
function loadIdl(): { idl: Idl; programId: PublicKey } {
  const possiblePaths = [
    path.resolve(__dirname, "..", "target", "idl", "token_sale.json"),
    path.resolve(__dirname, "..", ".anchor", "idl", "token_sale.json"),
  ];

  let idlPath: string | undefined;
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      idlPath = p;
      break;
    }
  }

  if (!idlPath) {
    throw new Error(
      "IDL file not found. Please build the Anchor program first:\n" +
      "  anchor build\n" +
      `Searched paths:\n  ${possiblePaths.join("\n  ")}`
    );
  }

  console.log(`📄 Loading IDL from: ${idlPath}`);
  const idlRaw = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

  // Read program ID from Anchor.toml or IDL metadata
  let programId: PublicKey;

  // Try IDL address first (Anchor 0.30) or metadata
  if (idlRaw.address) {
    programId = new PublicKey(idlRaw.address);
  } else if (idlRaw.metadata?.address) {
    programId = new PublicKey(idlRaw.metadata.address);
  } else {
    // Fall back to reading from the keypair file
    const keypairPath = path.resolve(
      __dirname, "..", "target", "deploy", "token_sale-keypair.json"
    );
    if (fs.existsSync(keypairPath)) {
      const raw = fs.readFileSync(keypairPath, "utf-8");
      const secretKey = Uint8Array.from(JSON.parse(raw));
      programId = Keypair.fromSecretKey(secretKey).publicKey;
    } else {
      throw new Error(
        "Could not determine program ID. Ensure the program is built " +
        "and deployed, or set metadata.address in the IDL."
      );
    }
  }

  return { idl: idlRaw as Idl, programId };
}

/**
 * Derives the Sale PDA from seeds: ["sale", mint_pubkey].
 */
function deriveSalePda(programId: PublicKey, mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("sale"), mint.toBuffer()],
    programId
  );
}

async function main(): Promise<void> {
  console.log("🚀 Starting sale initialization...\n");

  // 1. Load configuration
  const config = getConfig();
  const connection = getConnection();

  if (!config.mintAddress) {
    throw new Error(
      "MINT_ADDRESS is not set in .env. Run create-token.ts first."
    );
  }

  // 2. Load admin keypair
  console.log(`📂 Loading admin keypair from: ${config.adminKeypairPath}`);
  const admin: Keypair = loadKeypair(config.adminKeypairPath);
  console.log(`👤 Admin public key: ${admin.publicKey.toBase58()}`);

  const balance = await connection.getBalance(admin.publicKey);
  console.log(`💰 Admin balance: ${balance / 1e9} SOL\n`);

  // 3. Load IDL and set up Anchor program
  const { idl, programId } = loadIdl();
  console.log(`📋 Program ID: ${programId.toBase58()}\n`);

  const wallet = new Wallet(admin);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const program = new Program(idl, provider);

  // 4. Parse mint address
  const mint = new PublicKey(config.mintAddress);
  console.log(`🪙 Mint: ${mint.toBase58()}`);

  // 5. Derive the Sale PDA
  const [salePda, saleBump] = deriveSalePda(programId, mint);
  console.log(`📍 Sale PDA: ${salePda.toBase58()} (bump: ${saleBump})`);

  // 6. Derive the vault ATA (ATA of sale PDA for the mint)
  const vault = getAssociatedTokenAddressSync(mint, salePda, true);
  console.log(`🏦 Vault (Sale PDA ATA): ${vault.toBase58()}`);

  // 7. Get admin's token account
  const adminTokenAccount = getAssociatedTokenAddressSync(mint, admin.publicKey);
  console.log(`👛 Admin token account: ${adminTokenAccount.toBase58()}\n`);

  // 8. Calculate sale parameters
  const allocationBaseUnits = toBaseUnits(config.saleAllocation, config.tokenDecimals);
  const perWalletMaxBaseUnits = toBaseUnits(config.perWalletMaxTokens, config.tokenDecimals);
  const startTs = Math.floor(Date.now() / 1000);
  const endTs = startTs + config.saleDurationSeconds;

  console.log("📊 Sale Parameters:");
  console.log(`   Price:         ${config.priceLamportsPerWholeToken} lamports per whole token`);
  console.log(`   Allocation:    ${config.saleAllocation} tokens (${allocationBaseUnits.toString()} base units)`);
  console.log(`   Per-wallet max: ${config.perWalletMaxTokens} tokens (${perWalletMaxBaseUnits.toString()} base units)`);
  console.log(`   Start:         ${new Date(startTs * 1000).toISOString()}`);
  console.log(`   End:           ${new Date(endTs * 1000).toISOString()}`);
  console.log(`   Duration:      ${config.saleDurationSeconds} seconds\n`);

  // 9. Call initialize_sale instruction
  console.log("📝 Sending initialize_sale transaction...");
  const txSig = await program.methods
    .initializeSale(
      new BN(config.priceLamportsPerWholeToken),  // price_lamports_per_whole_token
      config.tokenDecimals,                        // token_decimals
      new BN(startTs),                             // start_ts
      new BN(endTs),                               // end_ts
      new BN(allocationBaseUnits.toString()),       // allocation (base units)
      new BN(perWalletMaxBaseUnits.toString())      // per_wallet_max (base units)
    )
    .accounts({
      admin: admin.publicKey,
      mint: mint,
      sale: salePda,
      treasury: new PublicKey(config.treasuryPubkey),
      vault: vault,
      adminTokenAccount: adminTokenAccount,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
    })
    .signers([admin])
    .rpc();

  await confirmTx(connection, txSig);

  // 10. Print summary
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  SALE INITIALIZATION COMPLETE");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Sale PDA:          ${salePda.toBase58()}`);
  console.log(`  Vault:             ${vault.toBase58()}`);
  console.log(`  Mint:              ${mint.toBase58()}`);
  console.log(`  Price:             ${config.priceLamportsPerWholeToken} lamports/token`);
  console.log(`  Allocation:        ${fromBaseUnits(allocationBaseUnits, config.tokenDecimals)} tokens`);
  console.log(`  Per-wallet cap:    ${fromBaseUnits(perWalletMaxBaseUnits, config.tokenDecimals)} tokens`);
  console.log(`  Start:             ${new Date(startTs * 1000).toISOString()}`);
  console.log(`  End:               ${new Date(endTs * 1000).toISOString()}`);
  console.log(`  Transaction:       ${txSig}`);
  console.log("═══════════════════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("❌ Error initializing sale:", err);
  process.exit(1);
});
