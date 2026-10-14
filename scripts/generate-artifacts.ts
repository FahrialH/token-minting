import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Keypair } from "@solana/web3.js";

function getDiscriminator(namespace: string, name: string): number[] {
  const preimage = `${namespace}:${name}`;
  const hash = crypto.createHash("sha256").update(preimage).digest();
  return Array.from(hash.subarray(0, 8));
}

function main() {
  const rootDir = path.resolve(__dirname, "..");
  const targetDir = path.join(rootDir, "target");
  const deployDir = path.join(targetDir, "deploy");
  const idlDir = path.join(targetDir, "idl");

  fs.mkdirSync(deployDir, { recursive: true });
  fs.mkdirSync(idlDir, { recursive: true });

  // 1. Program keypair
  const keypairPath = path.join(deployDir, "token_sale-keypair.json");
  let keypair: Keypair;
  if (fs.existsSync(keypairPath)) {
    const raw = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
    keypair = Keypair.fromSecretKey(Uint8Array.from(raw));
    console.log(`Existing keypair loaded from ${keypairPath}`);
  } else {
    keypair = Keypair.generate();
    fs.writeFileSync(keypairPath, JSON.stringify(Array.from(keypair.secretKey)), "utf-8");
    console.log(`New program keypair generated and saved to ${keypairPath}`);
  }

  const programId = keypair.publicKey.toBase58();
  console.log(`Program ID: ${programId}`);

  // 2. Update Anchor.toml
  const anchorTomlPath = path.join(rootDir, "Anchor.toml");
  let anchorToml = fs.readFileSync(anchorTomlPath, "utf-8");
  anchorToml = anchorToml.replace(
    /token_sale\s*=\s*"[^"]*"/,
    `token_sale = "${programId}"`
  );
  fs.writeFileSync(anchorTomlPath, anchorToml, "utf-8");
  console.log(`Updated Anchor.toml with program ID: ${programId}`);

  // 3. Update lib.rs declare_id!
  const libRsPath = path.join(rootDir, "programs", "token_sale", "src", "lib.rs");
  let libRs = fs.readFileSync(libRsPath, "utf-8");
  libRs = libRs.replace(
    /declare_id!\("[^"]*"\);/,
    `declare_id!("${programId}");`
  );
  fs.writeFileSync(libRsPath, libRs, "utf-8");
  console.log(`Updated lib.rs declare_id! with program ID: ${programId}`);

  // 4. Construct Anchor 0.30 IDL
  const idl = {
    address: programId,
    metadata: {
      name: "token_sale",
      version: "0.1.0",
      spec: "0.1.0",
      description: "Solana fixed-price token sale program built with Anchor"
    },
    instructions: [
      {
        name: "initialize_sale",
        discriminator: getDiscriminator("global", "initialize_sale"),
        accounts: [
          { name: "admin", writable: true, signer: true },
          { name: "mint" },
          { name: "sale", writable: true, pda: { seeds: [{ kind: "const", value: [115, 97, 108, 101] }, { kind: "account", path: "mint" }] } },
          { name: "treasury" },
          { name: "admin_token_account", writable: true },
          { name: "vault", writable: true },
          { name: "token_program", address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
          { name: "associated_token_program", address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" },
          { name: "system_program", address: "11111111111111111111111111111111" },
          { name: "rent", address: "SysvarRent111111111111111111111111111111111" }
        ],
        args: [
          { name: "price_lamports_per_whole_token", type: "u64" },
          { name: "token_decimals", type: "u8" },
          { name: "start_ts", type: "i64" },
          { name: "end_ts", type: "i64" },
          { name: "allocation", type: "u64" },
          { name: "per_wallet_max", type: "u64" }
        ]
      },
      {
        name: "buy",
        discriminator: getDiscriminator("global", "buy"),
        accounts: [
          { name: "buyer", writable: true, signer: true },
          { name: "sale", writable: true, pda: { seeds: [{ kind: "const", value: [115, 97, 108, 101] }, { kind: "account", path: "sale.mint", account: "sale" }] } },
          { name: "mint" },
          { name: "treasury", writable: true },
          { name: "vault", writable: true },
          { name: "buyer_token_account", writable: true },
          { name: "buyer_stats", writable: true, pda: { seeds: [{ kind: "const", value: [98, 117, 121, 101, 114] }, { kind: "account", path: "sale" }, { kind: "account", path: "buyer" }] } },
          { name: "token_program", address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
          { name: "associated_token_program", address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" },
          { name: "system_program", address: "11111111111111111111111111111111" },
          { name: "rent", address: "SysvarRent111111111111111111111111111111111" }
        ],
        args: [
          { name: "token_amount", type: "u64" }
        ]
      },
      {
        name: "toggle_pause",
        discriminator: getDiscriminator("global", "toggle_pause"),
        accounts: [
          { name: "admin", signer: true },
          { name: "sale", writable: true, pda: { seeds: [{ kind: "const", value: [115, 97, 108, 101] }, { kind: "account", path: "sale.mint", account: "sale" }] } }
        ],
        args: []
      },
      {
        name: "withdraw_unsold",
        discriminator: getDiscriminator("global", "withdraw_unsold"),
        accounts: [
          { name: "admin", writable: true, signer: true },
          { name: "sale", writable: true, pda: { seeds: [{ kind: "const", value: [115, 97, 108, 101] }, { kind: "account", path: "sale.mint", account: "sale" }] } },
          { name: "mint" },
          { name: "vault", writable: true },
          { name: "admin_token_account", writable: true },
          { name: "token_program", address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
          { name: "associated_token_program", address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" },
          { name: "system_program", address: "11111111111111111111111111111111" }
        ],
        args: []
      }
    ],
    accounts: [
      {
        name: "Sale",
        discriminator: getDiscriminator("account", "Sale"),
        type: {
          kind: "struct",
          fields: [
            { name: "admin", type: "pubkey" },
            { name: "mint", type: "pubkey" },
            { name: "treasury", type: "pubkey" },
            { name: "price_lamports_per_whole_token", type: "u64" },
            { name: "token_decimals", type: "u8" },
            { name: "start_ts", type: "i64" },
            { name: "end_ts", type: "i64" },
            { name: "allocation", type: "u64" },
            { name: "sold", type: "u64" },
            { name: "per_wallet_max", type: "u64" },
            { name: "paused", type: "bool" },
            { name: "bump", type: "u8" }
          ]
        }
      },
      {
        name: "BuyerStats",
        discriminator: getDiscriminator("account", "BuyerStats"),
        type: {
          kind: "struct",
          fields: [
            { name: "sale", type: "pubkey" },
            { name: "buyer", type: "pubkey" },
            { name: "total_purchased", type: "u64" },
            { name: "bump", type: "u8" }
          ]
        }
      }
    ],
    errors: [
      { code: 6000, name: "InvalidPrice", msg: "Price must be greater than zero" },
      { code: 6001, name: "InvalidTimeRange", msg: "start_ts must be before end_ts" },
      { code: 6002, name: "InvalidAllocation", msg: "Allocation must be greater than zero" },
      { code: 6003, name: "InvalidPerWalletMax", msg: "Per-wallet max must be greater than zero" },
      { code: 6004, name: "SaleNotStarted", msg: "Sale has not started yet" },
      { code: 6005, name: "SaleEnded", msg: "Sale has ended" },
      { code: 6006, name: "SalePaused", msg: "Sale is paused" },
      { code: 6007, name: "InvalidTokenAmount", msg: "token_amount must be a positive multiple of 10^decimals (whole tokens only)" },
      { code: 6008, name: "AllocationExceeded", msg: "Exceeds total sale allocation" },
      { code: 6009, name: "PerWalletMaxExceeded", msg: "Exceeds per-wallet purchase limit" },
      { code: 6010, name: "MathOverflow", msg: "Arithmetic overflow" },
      { code: 6011, name: "SaleNotEnded", msg: "Sale has not ended yet" }
    ]
  };

  const idlPath = path.join(idlDir, "token_sale.json");
  fs.writeFileSync(idlPath, JSON.stringify(idl, null, 2), "utf-8");
  console.log(`Generated IDL JSON saved to ${idlPath}`);
}

main();
