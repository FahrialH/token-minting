import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, BN, type Idl } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Connection,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

/**
 * Comprehensive test suite for the Solana Fixed-Price Token Sale program.
 * Cross-referenced with spec.md and Anchor 0.30 IDL.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadProgram(provider: AnchorProvider): Program {
  const rootDir = process.cwd();
  const idlPath = path.resolve(rootDir, "target", "idl", "token_sale.json");
  if (!fs.existsSync(idlPath)) {
    throw new Error(`IDL not found at ${idlPath}. Run 'anchor build' first.`);
  }
  const idl: Idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

  const keypairPath = path.resolve(
    rootDir, "target", "deploy", "token_sale-keypair.json"
  );
  let programId: PublicKey;
  if ((idl as any).address) {
    programId = new PublicKey((idl as any).address);
  } else if ((idl as any).metadata?.address) {
    programId = new PublicKey((idl as any).metadata.address);
  } else if (fs.existsSync(keypairPath)) {
    const raw = fs.readFileSync(keypairPath, "utf-8");
    const secretKey = Uint8Array.from(JSON.parse(raw));
    programId = Keypair.fromSecretKey(secretKey).publicKey;
  } else {
    throw new Error("Cannot determine program ID.");
  }

  return new Program(idl, provider);
}

function deriveSalePda(programId: PublicKey, mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("sale"), mint.toBuffer()],
    programId
  );
}

function deriveBuyerStatsPda(
  programId: PublicKey,
  sale: PublicKey,
  buyer: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("buyer"), sale.toBuffer(), buyer.toBuffer()],
    programId
  );
}

async function airdrop(
  connection: Connection,
  to: PublicKey,
  solAmount: number
): Promise<void> {
  const sig = await connection.requestAirdrop(to, solAmount * LAMPORTS_PER_SOL);
  const latestBlockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction({
    signature: sig,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
  });
}

// ─── Test Suite ────────────────────────────────────────────────────────────────

describe("Token Sale Program", () => {
  // ─── Config ──────────────────────────────────────────────────────────────
  const TOKEN_DECIMALS = 9;
  const TOTAL_SUPPLY = 1_000_000;
  const SALE_ALLOCATION = 500_000;
  const PRICE_LAMPORTS = 1_000_000; // 0.001 SOL per whole token
  const PER_WALLET_MAX = 10_000;
  const SALE_DURATION_SECONDS = 60; // 60 seconds for testing

  // ─── Shared State ────────────────────────────────────────────────────────
  const provider = AnchorProvider.env();
  anchor.setProvider(provider);

  let program: Program;
  let admin: Keypair;
  let buyer: Keypair;
  let nonAdmin: Keypair;
  let treasury: Keypair;
  let mint: PublicKey;
  let adminAta: PublicKey;
  let salePda: PublicKey;
  let saleBump: number;
  let vault: PublicKey;
  let startTs: number;
  let endTs: number;

  // ─── Setup ───────────────────────────────────────────────────────────────

  before("Setup: load program, create mint, fund accounts", async () => {
    program = loadProgram(provider);

    admin = Keypair.generate();
    buyer = Keypair.generate();
    nonAdmin = Keypair.generate();
    treasury = Keypair.generate();

    await airdrop(provider.connection, provider.wallet.publicKey, 100);
    await airdrop(provider.connection, admin.publicKey, 10);
    await airdrop(provider.connection, buyer.publicKey, 10);
    await airdrop(provider.connection, nonAdmin.publicKey, 2);
    await airdrop(provider.connection, treasury.publicKey, 2);

    mint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      TOKEN_DECIMALS
    );

    const adminAtaAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      mint,
      admin.publicKey
    );
    adminAta = adminAtaAccount.address;

    const totalSupplyBaseUnits = BigInt(TOTAL_SUPPLY) * BigInt(10 ** TOKEN_DECIMALS);
    await mintTo(
      provider.connection,
      admin,
      mint,
      adminAta,
      admin,
      totalSupplyBaseUnits
    );

    [salePda, saleBump] = deriveSalePda(program.programId, mint);
    vault = getAssociatedTokenAddressSync(mint, salePda, true);

    console.log("  Setup complete:");
    console.log(`    Program ID: ${program.programId.toBase58()}`);
    console.log(`    Admin:      ${admin.publicKey.toBase58()}`);
    console.log(`    Buyer:      ${buyer.publicKey.toBase58()}`);
    console.log(`    Mint:       ${mint.toBase58()}`);
    console.log(`    Sale PDA:   ${salePda.toBase58()}`);
    console.log(`    Vault:      ${vault.toBase58()}`);
  });

  // ─── Test: Successful Sale Initialization ─────────────────────────────────

  it("should initialize a sale successfully", async () => {
    startTs = Math.floor(Date.now() / 1000) - 5;
    endTs = startTs + SALE_DURATION_SECONDS;

    const allocationBaseUnits = new BN(
      (BigInt(SALE_ALLOCATION) * BigInt(10 ** TOKEN_DECIMALS)).toString()
    );
    const perWalletMaxBaseUnits = new BN(
      (BigInt(PER_WALLET_MAX) * BigInt(10 ** TOKEN_DECIMALS)).toString()
    );

    await program.methods
      .initializeSale(
        new BN(PRICE_LAMPORTS),
        TOKEN_DECIMALS,
        new BN(startTs),
        new BN(endTs),
        allocationBaseUnits,
        perWalletMaxBaseUnits
      )
      .accounts({
        admin: admin.publicKey,
        mint: mint,
        sale: salePda,
        treasury: treasury.publicKey,
        vault: vault,
        adminTokenAccount: adminAta,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    const saleAccount = await (program.account as any).sale.fetch(salePda);
    expect((saleAccount as any).admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect((saleAccount as any).mint.toBase58()).to.equal(mint.toBase58());
    expect((saleAccount as any).treasury.toBase58()).to.equal(treasury.publicKey.toBase58());
    expect((saleAccount as any).priceLamportsPerWholeToken.toNumber()).to.equal(PRICE_LAMPORTS);
    expect((saleAccount as any).startTs.toNumber()).to.equal(startTs);
    expect((saleAccount as any).endTs.toNumber()).to.equal(endTs);

    const vaultAccount = await getAccount(provider.connection, vault);
    expect(Number(vaultAccount.amount)).to.equal(SALE_ALLOCATION * 10 ** TOKEN_DECIMALS);
  });

  // ─── Test: Successful Purchase ────────────────────────────────────────────

  it("should process a successful purchase", async () => {
    const purchaseAmount = 100;
    const purchaseBaseUnits = new BN(
      (BigInt(purchaseAmount) * BigInt(10 ** TOKEN_DECIMALS)).toString()
    );
    const expectedSolCost = purchaseAmount * PRICE_LAMPORTS;

    const buyerAtaAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      buyer,
      mint,
      buyer.publicKey
    );
    const buyerAta = buyerAtaAccount.address;

    const [buyerStatsPda] = deriveBuyerStatsPda(program.programId, salePda, buyer.publicKey);

    const treasuryBalanceBefore = await provider.connection.getBalance(treasury.publicKey);

    await program.methods
      .buy(purchaseBaseUnits)
      .accounts({
        buyer: buyer.publicKey,
        sale: salePda,
        mint: mint,
        treasury: treasury.publicKey,
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

    const buyerAtaAfter = await getAccount(provider.connection, buyerAta);
    expect(Number(buyerAtaAfter.amount)).to.equal(purchaseAmount * 10 ** TOKEN_DECIMALS);

    const treasuryBalanceAfter = await provider.connection.getBalance(treasury.publicKey);
    expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(expectedSolCost);

    const stats = await (program.account as any).buyerStats.fetch(buyerStatsPda);
    expect(Number(stats.totalPurchased)).to.equal(purchaseAmount * 10 ** TOKEN_DECIMALS);
  });

  // ─── Test: Purchase with Wrong Mint Fails ─────────────────────────────────

  it("should reject purchase with wrong mint", async () => {
    const wrongMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      TOKEN_DECIMALS
    );

    const wrongBuyerAta = getAssociatedTokenAddressSync(wrongMint, buyer.publicKey);
    const [buyerStatsPda] = deriveBuyerStatsPda(program.programId, salePda, buyer.publicKey);

    const purchaseBaseUnits = new BN(
      (BigInt(10) * BigInt(10 ** TOKEN_DECIMALS)).toString()
    );

    try {
      await program.methods
        .buy(purchaseBaseUnits)
        .accounts({
          buyer: buyer.publicKey,
          sale: salePda,
          mint: wrongMint,
          treasury: treasury.publicKey,
          vault: vault,
          buyerTokenAccount: wrongBuyerAta,
          buyerStats: buyerStatsPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([buyer])
        .rpc();
      expect.fail("Transaction should have failed with wrong mint");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });

  // ─── Test: Purchase Before Start Time Fails ──────────────────────────────

  it("should reject purchase before start time", async () => {
    const futureMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      TOKEN_DECIMALS
    );
    const futureMintAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      futureMint,
      admin.publicKey
    );
    await mintTo(
      provider.connection,
      admin,
      futureMint,
      futureMintAta.address,
      admin,
      BigInt(TOTAL_SUPPLY) * BigInt(10 ** TOKEN_DECIMALS)
    );

    const [futureSalePda] = deriveSalePda(program.programId, futureMint);
    const futureVault = getAssociatedTokenAddressSync(futureMint, futureSalePda, true);

    const futureStart = Math.floor(Date.now() / 1000) + 3600;
    const futureEnd = futureStart + SALE_DURATION_SECONDS;
    const allocationBase = new BN(
      (BigInt(SALE_ALLOCATION) * BigInt(10 ** TOKEN_DECIMALS)).toString()
    );
    const perWalletBase = new BN(
      (BigInt(PER_WALLET_MAX) * BigInt(10 ** TOKEN_DECIMALS)).toString()
    );

    await program.methods
      .initializeSale(
        new BN(PRICE_LAMPORTS),
        TOKEN_DECIMALS,
        new BN(futureStart),
        new BN(futureEnd),
        allocationBase,
        perWalletBase
      )
      .accounts({
        admin: admin.publicKey,
        mint: futureMint,
        sale: futureSalePda,
        treasury: treasury.publicKey,
        vault: futureVault,
        adminTokenAccount: futureMintAta.address,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    const buyerFutureAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      buyer,
      futureMint,
      buyer.publicKey
    );
    const [buyerStatsPda] = deriveBuyerStatsPda(program.programId, futureSalePda, buyer.publicKey);

    try {
      await program.methods
        .buy(new BN((BigInt(10) * BigInt(10 ** TOKEN_DECIMALS)).toString()))
        .accounts({
          buyer: buyer.publicKey,
          sale: futureSalePda,
          mint: futureMint,
          treasury: treasury.publicKey,
          vault: futureVault,
          buyerTokenAccount: buyerFutureAta.address,
          buyerStats: buyerStatsPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([buyer])
        .rpc();
      expect.fail("Purchase before start time should fail");
    } catch (err: any) {
      expect(err).to.exist;
      expect(err.toString()).to.include("SaleNotStarted");
    }
  });

  // ─── Test: Purchase After End Time Fails ─────────────────────────────────

  it("should reject purchase after end time", async () => {
    const pastMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      TOKEN_DECIMALS
    );
    const pastMintAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      pastMint,
      admin.publicKey
    );
    await mintTo(
      provider.connection,
      admin,
      pastMint,
      pastMintAta.address,
      admin,
      BigInt(TOTAL_SUPPLY) * BigInt(10 ** TOKEN_DECIMALS)
    );

    const [pastSalePda] = deriveSalePda(program.programId, pastMint);
    const pastVault = getAssociatedTokenAddressSync(pastMint, pastSalePda, true);

    const pastStart = Math.floor(Date.now() / 1000) - 7200;
    const pastEnd = pastStart + 3600;
    const allocationBase = new BN(
      (BigInt(SALE_ALLOCATION) * BigInt(10 ** TOKEN_DECIMALS)).toString()
    );
    const perWalletBase = new BN(
      (BigInt(PER_WALLET_MAX) * BigInt(10 ** TOKEN_DECIMALS)).toString()
    );

    await program.methods
      .initializeSale(
        new BN(PRICE_LAMPORTS),
        TOKEN_DECIMALS,
        new BN(pastStart),
        new BN(pastEnd),
        allocationBase,
        perWalletBase
      )
      .accounts({
        admin: admin.publicKey,
        mint: pastMint,
        sale: pastSalePda,
        treasury: treasury.publicKey,
        vault: pastVault,
        adminTokenAccount: pastMintAta.address,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    const buyerPastAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      buyer,
      pastMint,
      buyer.publicKey
    );
    const [buyerStatsPda] = deriveBuyerStatsPda(program.programId, pastSalePda, buyer.publicKey);

    try {
      await program.methods
        .buy(new BN((BigInt(10) * BigInt(10 ** TOKEN_DECIMALS)).toString()))
        .accounts({
          buyer: buyer.publicKey,
          sale: pastSalePda,
          mint: pastMint,
          treasury: treasury.publicKey,
          vault: pastVault,
          buyerTokenAccount: buyerPastAta.address,
          buyerStats: buyerStatsPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([buyer])
        .rpc();
      expect.fail("Purchase after end time should fail");
    } catch (err: any) {
      expect(err).to.exist;
      expect(err.toString()).to.include("SaleEnded");
    }
  });

  // ─── Test: Purchase When Paused Fails ────────────────────────────────────

  it("should reject purchase when sale is paused", async () => {
    await program.methods
      .togglePause()
      .accounts({
        admin: admin.publicKey,
        sale: salePda,
      })
      .signers([admin])
      .rpc();

    const saleAccount = await (program.account as any).sale.fetch(salePda);
    expect((saleAccount as any).paused).to.equal(true);

    const buyerAta = getAssociatedTokenAddressSync(mint, buyer.publicKey);
    const [buyerStatsPda] = deriveBuyerStatsPda(program.programId, salePda, buyer.publicKey);

    try {
      await program.methods
        .buy(new BN((BigInt(10) * BigInt(10 ** TOKEN_DECIMALS)).toString()))
        .accounts({
          buyer: buyer.publicKey,
          sale: salePda,
          mint: mint,
          treasury: treasury.publicKey,
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
      expect.fail("Purchase while paused should fail");
    } catch (err: any) {
      expect(err).to.exist;
      expect(err.toString()).to.include("SalePaused");
    }

    // Unpause for subsequent tests
    await program.methods
      .togglePause()
      .accounts({
        admin: admin.publicKey,
        sale: salePda,
      })
      .signers([admin])
      .rpc();
  });

  // ─── Test: Purchase Exceeding Allocation Cap Fails ───────────────────────

  it("should reject purchase exceeding total allocation cap", async () => {
    const overAllocation = new BN(
      (BigInt(SALE_ALLOCATION + 1) * BigInt(10 ** TOKEN_DECIMALS)).toString()
    );

    const buyerAta = getAssociatedTokenAddressSync(mint, buyer.publicKey);
    const [buyerStatsPda] = deriveBuyerStatsPda(program.programId, salePda, buyer.publicKey);

    try {
      await program.methods
        .buy(overAllocation)
        .accounts({
          buyer: buyer.publicKey,
          sale: salePda,
          mint: mint,
          treasury: treasury.publicKey,
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
      expect.fail("Purchase exceeding allocation should fail");
    } catch (err: any) {
      expect(err).to.exist;
      expect(err.toString()).to.include("AllocationExceeded");
    }
  });

  // ─── Test: Purchase Exceeding Per-Wallet Cap Fails ───────────────────────

  it("should reject purchase exceeding per-wallet cap", async () => {
    const overWalletCap = new BN(
      (BigInt(PER_WALLET_MAX + 1) * BigInt(10 ** TOKEN_DECIMALS)).toString()
    );

    const buyerAta = getAssociatedTokenAddressSync(mint, buyer.publicKey);
    const [buyerStatsPda] = deriveBuyerStatsPda(program.programId, salePda, buyer.publicKey);

    try {
      await program.methods
        .buy(overWalletCap)
        .accounts({
          buyer: buyer.publicKey,
          sale: salePda,
          mint: mint,
          treasury: treasury.publicKey,
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
      expect.fail("Purchase exceeding per-wallet cap should fail");
    } catch (err: any) {
      expect(err).to.exist;
      expect(err.toString()).to.include("PerWalletMaxExceeded");
    }
  });

  // ─── Test: Admin Can Toggle Pause ────────────────────────────────────────

  it("should allow admin to toggle pause on and off", async () => {
    await program.methods
      .togglePause()
      .accounts({
        admin: admin.publicKey,
        sale: salePda,
      })
      .signers([admin])
      .rpc();

    let saleAccount = await (program.account as any).sale.fetch(salePda);
    expect((saleAccount as any).paused).to.equal(true);

    await program.methods
      .togglePause()
      .accounts({
        admin: admin.publicKey,
        sale: salePda,
      })
      .signers([admin])
      .rpc();

    saleAccount = await (program.account as any).sale.fetch(salePda);
    expect((saleAccount as any).paused).to.equal(false);
  });

  // ─── Test: Admin Can Withdraw Unsold Tokens After End Time ───────────────

  it("should allow admin to withdraw unsold tokens after end time", async () => {
    const endedMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      TOKEN_DECIMALS
    );
    const endedMintAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      endedMint,
      admin.publicKey
    );
    const mintAmount = BigInt(TOTAL_SUPPLY) * BigInt(10 ** TOKEN_DECIMALS);
    await mintTo(
      provider.connection,
      admin,
      endedMint,
      endedMintAta.address,
      admin,
      mintAmount
    );

    const [endedSalePda] = deriveSalePda(program.programId, endedMint);
    const endedVault = getAssociatedTokenAddressSync(endedMint, endedSalePda, true);

    const pastStart = Math.floor(Date.now() / 1000) - 7200;
    const pastEnd = pastStart + 3600;
    const allocationBase = new BN(
      (BigInt(SALE_ALLOCATION) * BigInt(10 ** TOKEN_DECIMALS)).toString()
    );
    const perWalletBase = new BN(
      (BigInt(PER_WALLET_MAX) * BigInt(10 ** TOKEN_DECIMALS)).toString()
    );

    await program.methods
      .initializeSale(
        new BN(PRICE_LAMPORTS),
        TOKEN_DECIMALS,
        new BN(pastStart),
        new BN(pastEnd),
        allocationBase,
        perWalletBase
      )
      .accounts({
        admin: admin.publicKey,
        mint: endedMint,
        sale: endedSalePda,
        treasury: treasury.publicKey,
        vault: endedVault,
        adminTokenAccount: endedMintAta.address,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    const adminAtaBefore = await getAccount(provider.connection, endedMintAta.address);
    const balanceBefore = adminAtaBefore.amount;

    await program.methods
      .withdrawUnsold()
      .accounts({
        admin: admin.publicKey,
        sale: endedSalePda,
        mint: endedMint,
        vault: endedVault,
        adminTokenAccount: endedMintAta.address,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const adminAtaAfter = await getAccount(provider.connection, endedMintAta.address);
    const tokensReturned = adminAtaAfter.amount - balanceBefore;
    expect(Number(tokensReturned)).to.equal(SALE_ALLOCATION * 10 ** TOKEN_DECIMALS);
  });

  // ─── Test: Non-Admin Cannot Withdraw ─────────────────────────────────────

  it("should prevent non-admin from withdrawing unsold tokens", async () => {
    const naMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      TOKEN_DECIMALS
    );
    const naMintAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      naMint,
      admin.publicKey
    );
    await mintTo(
      provider.connection,
      admin,
      naMint,
      naMintAta.address,
      admin,
      BigInt(TOTAL_SUPPLY) * BigInt(10 ** TOKEN_DECIMALS)
    );

    const [naSalePda] = deriveSalePda(program.programId, naMint);
    const naVault = getAssociatedTokenAddressSync(naMint, naSalePda, true);

    const pastStart = Math.floor(Date.now() / 1000) - 7200;
    const pastEnd = pastStart + 3600;
    const allocationBase = new BN(
      (BigInt(SALE_ALLOCATION) * BigInt(10 ** TOKEN_DECIMALS)).toString()
    );
    const perWalletBase = new BN(
      (BigInt(PER_WALLET_MAX) * BigInt(10 ** TOKEN_DECIMALS)).toString()
    );

    await program.methods
      .initializeSale(
        new BN(PRICE_LAMPORTS),
        TOKEN_DECIMALS,
        new BN(pastStart),
        new BN(pastEnd),
        allocationBase,
        perWalletBase
      )
      .accounts({
        admin: admin.publicKey,
        mint: naMint,
        sale: naSalePda,
        treasury: treasury.publicKey,
        vault: naVault,
        adminTokenAccount: naMintAta.address,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    const nonAdminAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      nonAdmin,
      naMint,
      nonAdmin.publicKey
    );

    try {
      await program.methods
        .withdrawUnsold()
        .accounts({
          admin: nonAdmin.publicKey,
          sale: naSalePda,
          mint: naMint,
          vault: naVault,
          adminTokenAccount: nonAdminAta.address,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([nonAdmin])
        .rpc();
      expect.fail("Non-admin should not be able to withdraw");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });

  // ─── Test: Cannot Withdraw Before End Time ───────────────────────────────

  it("should prevent withdrawal before sale end time", async () => {
    try {
      await program.methods
        .withdrawUnsold()
        .accounts({
          admin: admin.publicKey,
          sale: salePda,
          mint: mint,
          vault: vault,
          adminTokenAccount: adminAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();
      expect.fail("Withdraw before end time should fail");
    } catch (err: any) {
      expect(err).to.exist;
      expect(err.toString()).to.include("SaleNotEnded");
    }
  });
});
