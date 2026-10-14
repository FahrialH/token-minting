import * as fs from "fs";
import * as path from "path";
import { PublicKey, Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Program, AnchorProvider, Wallet, Idl } from "@coral-xyz/anchor";
import { getConfig, loadKeypair, getConnection, confirmTx, fromBaseUnits } from "./helpers";

/**
 * finalize-sale.ts
 *
 * Finalizes a completed token sale by withdrawing any unsold tokens
 * from the sale vault back to the admin's token account.
 *
 * Usage:
 *   npx ts-node scripts/finalize-sale.ts
 *
 * Prerequisites:
 *   - Sale must have ended (current time > end_ts)
 *   - .env file with MINT_ADDRESS set
 *   - Anchor program built and deployed
 */

/**
 * Loads the Anchor IDL from the built program artifacts.
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

  let programId: PublicKey;
  if (idlRaw.address) {
    programId = new PublicKey(idlRaw.address);
  } else if (idlRaw.metadata?.address) {
    programId = new PublicKey(idlRaw.metadata.address);
  } else {
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
  console.log("🚀 Starting sale finalization...\n");

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

  // 4. Parse mint address and derive accounts
  const mint = new PublicKey(config.mintAddress);
  const [salePda] = deriveSalePda(programId, mint);
  const vault = getAssociatedTokenAddressSync(mint, salePda, true);
  const adminTokenAccount = getAssociatedTokenAddressSync(mint, admin.publicKey);

  console.log(`🪙 Mint:              ${mint.toBase58()}`);
  console.log(`📍 Sale PDA:          ${salePda.toBase58()}`);
  console.log(`🏦 Vault:             ${vault.toBase58()}`);
  console.log(`👛 Admin ATA:         ${adminTokenAccount.toBase58()}\n`);

  // 5. Fetch sale account data
  console.log("📊 Fetching sale account data...");
  const saleAccount = await (program.account as any).sale.fetch(salePda);

  const endTs = (saleAccount as any).endTs.toNumber();
  const totalSold = BigInt((saleAccount as any).sold.toString());
  const allocation = BigInt((saleAccount as any).allocation.toString());
  const nowTs = Math.floor(Date.now() / 1000);

  console.log(`   Allocation:    ${fromBaseUnits(allocation, config.tokenDecimals)} tokens`);
  console.log(`   Total sold:    ${fromBaseUnits(totalSold, config.tokenDecimals)} tokens`);
  console.log(`   End time:      ${new Date(endTs * 1000).toISOString()}`);
  console.log(`   Current time:  ${new Date(nowTs * 1000).toISOString()}`);

  const unsold = allocation - totalSold;
  console.log(`   Unsold:        ${fromBaseUnits(unsold, config.tokenDecimals)} tokens\n`);

  if (nowTs < endTs) {
    const remaining = endTs - nowTs;
    const hours = Math.floor(remaining / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);
    console.log(
      `⚠️  Sale has not ended yet. ${hours}h ${minutes}m remaining.\n` +
      "   The on-chain program will reject this transaction if called before end_ts.\n" +
      "   Proceeding anyway (the program will enforce the check)..."
    );
  }

  if (unsold <= BigInt(0)) {
    console.log("ℹ️  All tokens were sold. Nothing to withdraw.");
    return;
  }

  // 6. Call withdraw_unsold instruction
  console.log("📝 Sending withdraw_unsold transaction...");
  const txSig = await program.methods
    .withdrawUnsold()
    .accounts({
      admin: admin.publicKey,
      sale: salePda,
      mint: mint,
      vault: vault,
      adminTokenAccount: adminTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([admin])
    .rpc();

  await confirmTx(connection, txSig);

  // 7. Print summary
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  SALE FINALIZATION COMPLETE");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Sale PDA:          ${salePda.toBase58()}`);
  console.log(`  Total sold:        ${fromBaseUnits(totalSold, config.tokenDecimals)} tokens`);
  console.log(`  Unsold withdrawn:  ${fromBaseUnits(unsold, config.tokenDecimals)} tokens`);
  console.log(`  Returned to:       ${adminTokenAccount.toBase58()}`);
  console.log(`  Transaction:       ${txSig}`);
  console.log("═══════════════════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("❌ Error finalizing sale:", err);
  process.exit(1);
});
