import * as fs from "fs";
import * as path from "path";
import { PublicKey, SystemProgram, Keypair, LAMPORTS_PER_SOL, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import { Program, AnchorProvider, Wallet, BN, Idl } from "@coral-xyz/anchor";
import { getConfig, loadKeypair, getConnection, confirmTx, toBaseUnits, fromBaseUnits } from "./helpers";

/**
 * buy-tokens.ts
 *
 * Purchases tokens from an active fixed-price token sale on Devnet.
 * Adheres strictly to spec.md:
 * - Purchases in whole tokens (multiple of 10^decimals).
 * - Pays price_lamports_per_whole_token * whole_tokens.
 * - Delivers tokens immediately to buyer's ATA.
 * - Derives ["buyer", sale, buyer] PDA to track buyer statistics.
 *
 * Usage:
 *   npx ts-node scripts/buy-tokens.ts [whole_tokens] [optional_buyer_keypair_path]
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

  const idlRaw = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  let programId: PublicKey;
  if (idlRaw.address) {
    programId = new PublicKey(idlRaw.address);
  } else if (idlRaw.metadata?.address) {
    programId = new PublicKey(idlRaw.metadata.address);
  } else {
    const keypairPath = path.resolve(__dirname, "..", "target", "deploy", "token_sale-keypair.json");
    if (fs.existsSync(keypairPath)) {
      const raw = fs.readFileSync(keypairPath, "utf-8");
      const secretKey = Uint8Array.from(JSON.parse(raw));
      programId = Keypair.fromSecretKey(secretKey).publicKey;
    } else {
      throw new Error("Could not determine program ID.");
    }
  }

  return { idl: idlRaw as Idl, programId };
}

function deriveSalePda(programId: PublicKey, mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("sale"), mint.toBuffer()],
    programId
  );
}

function deriveBuyerStatsPda(programId: PublicKey, sale: PublicKey, buyer: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("buyer"), sale.toBuffer(), buyer.toBuffer()],
    programId
  );
}

async function main(): Promise<void> {
  console.log("🛒 Starting Token Purchase...\n");

  const config = getConfig();
  const connection = getConnection();

  if (!config.mintAddress) {
    throw new Error("MINT_ADDRESS is not set in .env.");
  }

  // Parse arguments
  const args = process.argv.slice(2);
  const tokenCount = args[0] ? parseInt(args[0], 10) : 10; // default 10 whole tokens
  const buyerKeypairPath = args[1] || config.adminKeypairPath;

  console.log(`📂 Loading buyer keypair from: ${buyerKeypairPath}`);
  const buyer: Keypair = loadKeypair(buyerKeypairPath);
  console.log(`👤 Buyer public key: ${buyer.publicKey.toBase58()}`);

  const balanceLamports = await connection.getBalance(buyer.publicKey);
  console.log(`💰 Buyer SOL balance: ${balanceLamports / LAMPORTS_PER_SOL} SOL\n`);

  const { idl, programId } = loadIdl();
  console.log(`📋 Program ID: ${programId.toBase58()}`);

  const wallet = new Wallet(buyer);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const program = new Program(idl, provider);

  const mint = new PublicKey(config.mintAddress);
  const [salePda] = deriveSalePda(programId, mint);
  const vault = getAssociatedTokenAddressSync(mint, salePda, true);
  const buyerAta = getAssociatedTokenAddressSync(mint, buyer.publicKey);
  const [buyerStatsPda] = deriveBuyerStatsPda(programId, salePda, buyer.publicKey);

  // Fetch sale account
  const saleAccount = await (program.account as any).sale.fetch(salePda);
  const treasury = saleAccount.treasury as PublicKey;
  const pricePerWholeToken = Number(saleAccount.priceLamportsPerWholeToken);
  const decimals = saleAccount.tokenDecimals;

  const totalCostLamports = tokenCount * pricePerWholeToken;
  console.log(`🪙 Mint:             ${mint.toBase58()}`);
  console.log(`📍 Sale PDA:         ${salePda.toBase58()}`);
  console.log(`🏦 Vault:            ${vault.toBase58()}`);
  console.log(`👛 Buyer ATA:        ${buyerAta.toBase58()}`);
  console.log(`📊 Buyer Stats PDA:  ${buyerStatsPda.toBase58()}`);
  console.log(`🏛️  Treasury:         ${treasury.toBase58()}`);
  console.log(`💳 Purchasing:       ${tokenCount} tokens`);
  console.log(`💵 Total Cost:       ${totalCostLamports} lamports (${totalCostLamports / LAMPORTS_PER_SOL} SOL)\n`);

  if (balanceLamports < totalCostLamports) {
    throw new Error(`Insufficient SOL balance. Required: ${totalCostLamports / LAMPORTS_PER_SOL} SOL, Available: ${balanceLamports / LAMPORTS_PER_SOL} SOL`);
  }

  const tokenAmountBaseUnits = toBaseUnits(tokenCount, decimals);

  console.log("📝 Sending buy transaction...");
  const txSig = await program.methods
    .buy(new BN(tokenAmountBaseUnits.toString()))
    .accounts({
      buyer: buyer.publicKey,
      sale: salePda,
      mint: mint,
      treasury: treasury,
      vault: vault,
      buyerTokenAccount: buyerAta,
      buyerStats: buyerStatsPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([buyer])
    .rpc();

  await confirmTx(connection, txSig);

  // Verify buyer ATA balance post purchase
  const buyerAtaInfo = await getAccount(connection, buyerAta);
  const buyerStatsAccount = await (program.account as any).buyerStats.fetch(buyerStatsPda);

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  PURCHASE SUCCESSFUL");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Purchased:         ${tokenCount} tokens`);
  console.log(`  Buyer ATA Balance: ${fromBaseUnits(BigInt(buyerAtaInfo.amount.toString()), decimals)} tokens`);
  console.log(`  Buyer Total Stats: ${fromBaseUnits(BigInt(buyerStatsAccount.totalPurchased.toString()), decimals)} tokens`);
  console.log(`  Transaction:       ${txSig}`);
  console.log("═══════════════════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("❌ Error executing purchase:", err);
  process.exit(1);
});
