# Solana Fixed-Price Token Sale — Mainnet Launch Specification & Agent Guide

## Goal
A secure, production-grade deployment of the classic SPL token sale program to Solana Mainnet-Beta, verifiable token creation with immutable Metaplex metadata, and execution of the fixed-price sale lifecycle with strict operational and security invariants.

---

## Scope

### In Scope
- SBF compilation and deterministic binary verification for Mainnet.
- Program deployment to `mainnet-beta` using a dedicated private RPC and isolated keypair.
- On-chain IDL account initialization for explorer and wallet decoding.
- Classic SPL Token creation, total supply minting, Metaplex metadata attachment (Arweave/IPFS), and irreversible mint authority revocation.
- Fixed-price sale initialization on Mainnet with PDA vault funding and multi-sig/cold treasury routing.
- Verification of purchasing, pause control, and post-sale unsold token reclamation.
- Domain security and anti-phishing whitelisting (Blowfish/Blockaid).

### Out of Scope
- DEX liquidity pool provisioning (Raydium, Meteora AMMs).
- Web frontend hosting infrastructure.
- Fiat onramps, KYC/allowlists, vesting schedules, and dynamic pricing models.

---

## Defaults & Prerequisites

- **Network**: `mainnet-beta` via private RPC (Helius, QuickNode, or Triton). Never use public RPC.
- **Token program**: classic SPL Token (not Token-2022).
- **Decimals**: default 9.
- **Payment**: native SOL delivered directly to the Treasury.
- **Treasury**: configured cold storage or Squads Protocol Multi-Sig PDA.
- **Price**: integer lamports per whole token.
- **Purchase quantities**: whole tokens only (`token_amount % 10^decimals == 0`).
- **Delivery**: immediate token transfer to buyer ATA upon payment confirmation.
- **Mint authority**: permanently revoked immediately after Metaplex metadata creation.
- **Freeze authority**: none (`null`).
- **Deployer balance**: minimum 2.5 SOL on Mainnet before deployment begins.
- **Metadata storage**: permanent decentralized storage (Arweave or IPFS).

---

## Architecture & On-Chain State

### 1. State Accounts
* **Sale PDA**: `["sale", mint]`
  * `admin: Pubkey` — Sale controller (can pause, withdraw unsold after end).
  * `mint: Pubkey` — Token mint sold.
  * `treasury: Pubkey` — Receives SOL payments directly.
  * `price_lamports_per_whole_token: u64` — Price in lamports per $10^9$ base units.
  * `token_decimals: u8` — Decimal precision.
  * `start_ts: i64` / `end_ts: i64` — Unix timestamps bounding the sale.
  * `allocation: u64` / `sold: u64` — Total inventory and purchased counters (base units).
  * `per_wallet_max: u64` — Maximum base units a single buyer wallet may purchase.
  * `paused: bool` — Emergency purchase halt switch.
  * `bump: u8` — Canonical PDA bump.

* **BuyerStats PDA**: `["buyer", sale, buyer]`
  * `sale: Pubkey` / `buyer: Pubkey`
  * `total_purchased: u64` — Cumulative purchases tracked against `per_wallet_max`.
  * `bump: u8` — Canonical PDA bump.

* **Token Vault**: Associated Token Account for `mint` owned by `Sale` PDA.

---

## Strict Agent Execution Instructions

The executing agent or engineer must follow these phases sequentially without skipping any validation gate.

### Phase 1: Environment & Key Isolation
1. Confirm deployer keypair is fresh and isolated from any Devnet keypairs.
2. Confirm `SOLANA_CLUSTER` in environment points to a paid/dedicated Mainnet RPC (e.g. `https://mainnet.helius-rpc.com/?api-key=...`).
3. Confirm `TREASURY_PUBKEY` points to a verified Squads Multi-Sig or Ledger cold wallet.
4. Verify deployer wallet balance:
   ```bash
   solana balance --url <MAINNET_RPC_URL> --keypair <PATH_TO_MAINNET_KEYPAIR>
   ```
   *Gate: Balance must be $\ge 2.5\text{ SOL}$. If insufficient, halt until funded.*

### Phase 2: Program ID Synchronization & Build
1. Generate fresh deploy keypair:
   ```bash
   solana-keygen new -o target/deploy/token_sale_mainnet-keypair.json --no-bip39-passphrase
   ```
2. Extract the Program ID:
   ```bash
   solana address --keypair target/deploy/token_sale_mainnet-keypair.json
   ```
3. Synchronize this Program ID across:
   * `programs/token_sale/src/lib.rs` (`declare_id!(...)`)
   * `Anchor.toml` (`[programs.mainnet]`)
   * `target/idl/token_sale.json` (`"address": "..."`)
4. Compile deterministic SBF binary inside Docker:
   ```bash
   docker run --rm -v "${PWD}:/work" -w /work backpackapp/build:v0.30.1 anchor build --no-idl
   ```
5. Verify `target/deploy/token_sale.so` exists and binary size is ~312 KB.

### Phase 3: Program Deployment & On-Chain IDL
1. Deploy SBF binary to Mainnet-Beta:
   ```bash
   docker run --rm \
     -v "<KEYPAIR_DIR>:/root/.config/solana:ro" \
     -v "${PWD}:/work" \
     -w /work backpackapp/build:v0.30.1 \
     solana program deploy /work/target/deploy/token_sale.so \
       --program-id /work/target/deploy/token_sale_mainnet-keypair.json \
       --keypair /root/.config/solana/mainnet-admin.json \
       --url "<MAINNET_RPC_URL>"
   ```
2. Initialize on-chain IDL account:
   ```bash
   docker run --rm \
     -v "<KEYPAIR_DIR>:/root/.config/solana:ro" \
     -v "${PWD}:/work" \
     -w /work backpackapp/build:v0.30.1 \
     anchor idl init -f /work/target/idl/token_sale.json <PROGRAM_ID> \
       --provider.cluster "<MAINNET_RPC_URL>" \
       --provider.wallet /root/.config/solana/mainnet-admin.json
   ```
   *Gate: Verify deployment using `solana program show <PROGRAM_ID> --url <MAINNET_RPC_URL>`.*

### Phase 4: Token Creation & Metaplex Metadata Binding
1. Verify off-chain metadata JSON and image are permanently hosted on Arweave or IPFS.
2. Configure `.env.mainnet`:
   * `TOKEN_NAME`: string ($\le 32$ chars)
   * `TOKEN_SYMBOL`: string ($\le 10$ chars)
   * `TOKEN_METADATA_URI`: Arweave/IPFS URL
   * `TOTAL_SUPPLY`: integer supply
   * `REVOKE_MINT_AUTHORITY=true`
3. Execute mint script:
   ```bash
   $env:ENV_FILE=".env.mainnet"; npm run create-token
   ```
4. Verify execution order:
   * Mint created $\rightarrow$ Admin ATA created $\rightarrow$ Total supply minted $\rightarrow$ Metaplex Metadata account created $\rightarrow$ Mint authority revoked.
   * Record outputted `MINT_ADDRESS` into `.env.mainnet`.

### Phase 5: Sale Initialization & Vault Deposit
1. Configure sale terms in `.env.mainnet`:
   * `SALE_ALLOCATION`: base units to sell.
   * `PRICE_LAMPORTS_PER_WHOLE_TOKEN`: price in lamports per 1 whole token.
   * `PER_WALLET_MAX_TOKENS`: limit per buyer.
   * `SALE_DURATION_SECONDS`: duration in seconds.
2. Execute sale creation:
   ```bash
   $env:ENV_FILE=".env.mainnet"; npm run create-sale
   ```
3. Verify on-chain state:
   ```bash
   $env:ENV_FILE=".env.mainnet"; npm run check-balance
   ```
   *Gate: Sale Vault ATA must hold exact `SALE_ALLOCATION` tokens.*

### Phase 6: Post-Launch Security & Whitelisting
1. Submit dApp domain and Program ID to Blowfish: [https://blowfish.xyz/](https://blowfish.xyz/) to whitelist against Solflare/Phantom scam heuristics.
2. Verify token on Solscan and Solana Explorer:
   * `https://solscan.io/token/<MINT_ADDRESS>`
   * Ensure Token Name, Symbol, and Logo appear correctly.

### Phase 7: Sale Finalization (Post-Sale Only)
1. Verify sale end timestamp has passed: `now >= end_ts`.
2. Execute finalization script:
   ```bash
   $env:ENV_FILE=".env.mainnet"; npm run finalize-sale
   ```
3. Confirm unsold tokens return to Admin ATA.

---

## Security Invariants & Guardrails

1. **Authority Revocation Order**: Metaplex metadata account creation requires active mint authority. Mint authority **must** be revoked *after* metadata initialization, never before.
2. **Immutable Treasury**: The treasury address is written permanently to the `Sale` PDA during `initialize_sale`. Buyers cannot redirect SOL payments.
3. **Whole-Token Multiples**: Program rejects any purchase where `token_amount % 10^decimals != 0`.
4. **Time Window Guarantees**: Purchases before `start_ts` or at/after `end_ts` fail immediately.
5. **Checked Math**: All additions, multiplications, and counter increments must use checked operations (`checked_add`, `checked_mul`).
6. **No Committed Keys**: Mainnet keypairs must never be committed to git or exposed in build artifacts.

---

## Acceptance Criteria

The Mainnet launch is complete only when all criteria below are verified:

- [ ] **RPC Isolation**: Deployment executed through private dedicated RPC endpoint.
- [ ] **Bytecode Verification**: On-chain Program matches local SBF release binary hash.
- [ ] **On-Chain IDL**: Program IDL is published and verified on Solana Mainnet.
- [ ] **Supply Cap**: Mint authority is `None` (verifiably revoked); no freeze authority.
- [ ] **Metadata Rendering**: Phantom and Solscan correctly render Token Name, Symbol, and Logo image from permanent storage.
- [ ] **Vault Custody**: Sale Vault ATA is owned by the `Sale` PDA and funded with exact `SALE_ALLOCATION`.
- [ ] **Treasury Delivery**: Purchase transactions deliver SOL directly to the multi-sig/cold treasury with zero intermediate custody.
- [ ] **Guardrails Enforced**: Attempts to buy after `end_ts`, buy beyond wallet cap, or withdraw before `end_ts` fail with specific error codes.
- [ ] **Runbook Documentation**: All Mainnet addresses (Program ID, Mint, Sale PDA, Vault ATA, Treasury) recorded in `PROJECT_SUMMARY.md`.

---

## Known Limitations & Operational Notes

- **Network Congestion**: During periods of high Solana traffic, priority fees may need adjustment in `@solana/web3.js` transactions (`ComputeBudgetProgram.setComputeUnitPrice`).
- **Irreversible Revocation**: Once `REVOKE_MINT_AUTHORITY` executes, no additional tokens can ever be minted. Total supply is mathematically fixed.
- **DEX Listing**: Sale tokens must conclude initial sale distribution or reserve liquidity before pooling on Raydium/Meteora to prevent front-running.
