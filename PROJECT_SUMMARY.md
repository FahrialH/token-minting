# Solana Fixed-Price Token Sale — Project Summary & Architecture Guide

## 1. Executive Summary

The **Solana Fixed-Price Token Sale** project is an end-to-end, Devnet-first solution for launching a classic SPL Token with a fixed supply and conducting a fixed-price sale paid in native SOL. 

The project delivers immediate token distribution to buyers upon purchase, enforces rigid cap and timing controls, allows emergency pausing, and guarantees that unsold tokens can be reclaimed by the administrator once the sale period concludes.

---

## 2. Core Architecture & Tech Stack

* **Blockchain**: Solana (Devnet-first, expandable to Mainnet)
* **Smart Contract Framework**: Anchor `v0.30.1` (Rust 2021)
* **Token Standard**: Classic SPL Token (`@solana/spl-token` `^0.4.9`) — *Not Token-2022*
* **Client SDK**: `@solana/web3.js` `^1.95.4`, `@coral-xyz/anchor` `^0.30.1`
* **Runtime / Testing**: Node.js, TypeScript (`5.6.3`), `ts-node`, `mocha`, `chai`, `ts-mocha`

```
┌────────────────────────────────────────────────────────────────────────┐
│                              Admin                                     │
└────────┬───────────────────────────────────────────────────────┬───────┘
         │ 1. create-token.ts (creates Mint & mints supply)      │
         │ 2. create-sale.ts (deposits allocation to Vault)      │ 4. finalize-sale.ts
         ▼                                                       ▼    (withdraw unsold)
┌────────────────────────────────────────────────────────────────────────┐
│                        Anchor Program: token_sale                      │
│                                                                        │
│  State:                                                                │
│  • Sale PDA: ["sale", mint]                                            │
│  • BuyerStats PDA: ["buyer", sale, buyer]                              │
│  • Vault ATA: Owned by Sale PDA                                        │
└───────────────────────────────────▲────────────────────────────────────┘
                                    │ 3. buy(token_amount)
                                    │    - Transfers SOL to Treasury
                                    │    - Vault transfers SPL to Buyer ATA
                                    │
                         ┌──────────┴──────────┐
                         │        Buyer        │
                         └─────────────────────┘
```

---

## 3. On-Chain State Accounts & PDA Seeds

### A. Sale State Account
* **Seeds**: `[b"sale", mint.key().as_ref()]`
* **Address Derivation**: Unique 1:1 relationship between an SPL Token Mint and its Sale.
* **Fields**:
  * `admin: Pubkey` — The authorized manager for pause and withdrawal.
  * `mint: Pubkey` — The SPL Token being sold.
  * `treasury: Pubkey` — The external account receiving SOL payments directly.
  * `price_lamports_per_whole_token: u64` — Price in lamports for 1 whole token (e.g., $10^9$ base units).
  * `token_decimals: u8` — Mint decimal precision (default: 9).
  * `start_ts: i64` — Unix timestamp when purchases become active.
  * `end_ts: i64` — Unix timestamp when sale closes.
  * `allocation: u64` — Total base units deposited into the sale vault.
  * `sold: u64` — Cumulative base units purchased.
  * `per_wallet_max: u64` — Maximum base units a single buyer wallet can purchase.
  * `paused: bool` — Circuit breaker flag; freezes purchases when `true`.
  * `bump: u8` — Canonical PDA bump seed.

### B. BuyerStats Account
* **Seeds**: `[b"buyer", sale.key().as_ref(), buyer.key().as_ref()]`
* **Purpose**: Tracks individual wallet purchasing history to strictly enforce per-wallet allocation limits across multiple transactions.
* **Fields**:
  * `sale: Pubkey` — Target sale reference.
  * `buyer: Pubkey` — Buyer wallet address.
  * `total_purchased: u64` — Total base units purchased by this wallet.
  * `bump: u8` — Canonical PDA bump seed.

### C. Token Vault
* **Address**: Associated Token Account (ATA) of the `Sale` PDA for the configured mint.
* **Authority**: Controlled exclusively by the `Sale` PDA using program seeds: `[b"sale", mint.key().as_ref(), &[bump]]`.

---

## 4. Program Instructions & Logic Flow

### 1. `initialize_sale`
* **Signer**: `admin`
* **Validation**:
  * `price_lamports_per_whole_token > 0`
  * `start_ts < end_ts`
  * `allocation > 0`
  * `per_wallet_max > 0`
* **Execution**:
  1. Initializes the `Sale` PDA.
  2. Creates the Vault ATA (owned by the `Sale` PDA) via the Associated Token Program.
  3. Transfers `allocation` tokens from the `admin` token account into the vault.

### 2. `buy(token_amount: u64)`
* **Signer**: `buyer`
* **Validation**:
  * Current clock time $\ge$ `start_ts` and $<$ `end_ts`.
  * `paused == false`.
  * `token_amount > 0` and is an integer multiple of $10^{\text{decimals}}$ (whole tokens only).
  * `sold + token_amount <= allocation` (allocation cap).
  * `buyer_stats.total_purchased + token_amount <= per_wallet_max` (wallet cap).
* **Payment & Delivery (Atomic)**:
  1. Calculates whole tokens: $\text{tokens} = \frac{\text{token\_amount}}{10^{\text{decimals}}}$.
  2. Calculates total cost: $\text{cost} = \text{tokens} \times \text{price\_lamports\_per\_whole\_token}$.
  3. Transfers SOL directly from `buyer` to `treasury` via System Program CPI.
  4. Transfers tokens from `vault` to `buyer_token_account` via SPL Token CPI with `Sale` PDA signing.
  5. Updates `sale.sold` and `buyer_stats.total_purchased`.

### 3. `toggle_pause`
* **Signer**: `admin`
* **Constraint**: `has_one = admin`
* **Action**: Inverts `sale.paused` boolean (`true` $\leftrightarrow$ `false`).

### 4. `withdraw_unsold`
* **Signer**: `admin`
* **Validation**: Current clock time $\ge$ `end_ts`.
* **Execution**: Computes remaining inventory ($\text{allocation} - \text{sold}$) and transfers all remaining tokens from the vault back to the `admin` token account using PDA signer seeds.

---

## 5. Security Safeguards & Design Decisions

1. **Direct Treasury Settlement**: Native SOL payments bypass the contract entirely, eliminating contract drain exploits or custodial liabilities.
2. **Strict Integer & Checked Arithmetic**: All calculations utilize checked operations (`checked_add`, `checked_mul`, `checked_sub`, `checked_div`, `checked_pow`), completely preventing overflow/underflow vulnerabilities.
3. **Whole-Token Granularity**: Requiring purchases in whole token units prevents precision loss, fractional dust rounding errors, and micro-transaction spam.
4. **Permanent Supply Guarantee**: Mint authority is permanently revoked upon token generation by default (`REVOKE_MINT_AUTHORITY=true`).
5. **PDA Vault Isolation**: The token vault is bound deterministically to the mint and sale state; no arbitrary accounts or transfer destinations can be substituted.
6. **Program Constraints**: Standard Anchor constraints (`has_one`, `seeds`, `bump`, `init_if_needed`) protect state ownership and authority boundaries.

---

## 6. Project Structure

```
token-minting/
├── Anchor.toml                     # Anchor workspace configuration (Devnet)
├── Cargo.lock
├── package.json                    # Node dependencies & execution scripts
├── tsconfig.json                   # TypeScript compiler configuration
├── .env.example                    # Environment variable configuration template
├── .gitignore                      # Git exclusion rules
├── spec.md                         # Original design specifications
├── PROJECT_SUMMARY.md              # Architectural & operational documentation
├── programs/
│   └── token_sale/
│       ├── Cargo.toml              # Rust crate dependencies & Anchor features
│       ├── Xargo.toml              # BPF compilation settings
│       └── src/
│           └── lib.rs              # Anchor on-chain program code
├── scripts/
│   ├── helpers.ts                  # Shared utilities (connection, keypair, units)
│   ├── create-token.ts             # Phase 1: Create mint, mint supply, revoke auth
│   ├── create-sale.ts              # Phase 2: Derive PDA & initialize on-chain sale
│   └── finalize-sale.ts            # Phase 3: Withdraw unsold inventory after end
└── tests/
    └── token-sale.ts               # Complete Mocha/Chai test suite (12 scenarios)
```

---

## 7. Environment Variables Reference (`.env`)

| Variable | Description | Example / Default |
| :--- | :--- | :--- |
| `ADMIN_KEYPAIR_PATH` | Filepath to operator/admin Solana keypair JSON | `~/.config/solana/id.json` |
| `SOLANA_CLUSTER` | Solana RPC target (`devnet`, `testnet`, `mainnet-beta`, `localnet`) | `devnet` |
| `TOKEN_DECIMALS` | SPL token decimal precision | `9` |
| `TOTAL_SUPPLY` | Total tokens minted during creation | `1000000` |
| `REVOKE_MINT_AUTHORITY` | Whether to revoke minting permissions permanently | `true` |
| `SALE_ALLOCATION` | Tokens designated for sale through the contract | `500000` |
| `PRICE_LAMPORTS_PER_WHOLE_TOKEN` | Cost in lamports per 1 whole token (1 SOL = $10^9$ lamports) | `1000000` (0.001 SOL) |
| `PER_WALLET_MAX_TOKENS` | Maximum whole tokens permitted per wallet address | `10000` |
| `SALE_DURATION_SECONDS` | Sale lifespan in seconds from initialization | `86400` (24 Hours) |
| `TREASURY_PUBKEY` | Public key where purchase proceeds are transferred | `<WALLET_PUBKEY>` |
| `MINT_ADDRESS` | Created token mint address (populated after Phase 1) | `<MINT_PUBKEY>` |

---

## 8. Deployment & Operational Lifecycle

### Step 1: Install Dependencies
```bash
npm install
```

### Step 2: Build & Sync Anchor Program ID
```bash
# Compile Rust program and generate IDL / Keypair
anchor build

# Synchronize declared ID in lib.rs and Anchor.toml with target/deploy keypair
anchor keys sync

# Rebuild with updated ID
anchor build
```

### Step 3: Run the Test Suite
Ensure a local test validator or local test runner is active:
```bash
anchor test
# Or run tests directly with ts-mocha:
npx ts-mocha -p ./tsconfig.json -t 1000000 tests/**/*.ts
```

### Step 4: Configure Environment
Copy `.env.example` to `.env` and configure your parameters:
```bash
cp .env.example .env
```
Ensure your admin wallet is funded on Devnet:
```bash
solana airdrop 2 <ADMIN_PUBKEY> --url devnet
```

### Step 5: Deploy the Program to Devnet
```bash
anchor deploy --provider.cluster devnet
```

### Step 6: Execute Sale Lifecycle
1. **Create Token (with optional Metaplex Metadata)**:
   ```bash
   npm run create-token
   ```
   *Creates the mint, mints total supply, attaches on-chain Metaplex metadata (if `TOKEN_NAME` is set in `.env`), and revokes mint authority. Logs the newly created mint address. Copy this into `MINT_ADDRESS` in `.env`.*

2. **Initialize Sale**:
   ```bash
   npm run create-sale
   ```
   *Initializes the Sale PDA and transfers `SALE_ALLOCATION` tokens into the newly initialized sale vault.*

3. **Purchase Tokens (Buyer)**:
   ```bash
   npm run buy-tokens -- 10
   # Or with a custom buyer keypair:
   npm run buy-tokens -- 10 path/to/buyer.json
   ```

4. **Inspect Balances**:
   ```bash
   npm run check-balance
   ```

5. **Reclaim Unsold Tokens (Post-Sale)**:
   ```bash
   npm run finalize-sale
   ```
   *Validates that the sale window has passed and returns all remaining inventory to the admin.*

---

## 9. Test Suite Coverage

The test file `tests/token-sale.ts` validates the following 12 critical paths (12 of 12 passing):
1. `[+]` Successful initialization of sale and funding of vault.
2. `[+]` Successful whole-token purchase (verifies SOL deduction from buyer and token credit to buyer ATA).
3. `[-]` Rejection when attempting purchase with an invalid/mismatched mint account.
4. `[-]` Rejection when purchasing before `start_ts` (`SaleNotStarted`).
5. `[-]` Rejection when purchasing after `end_ts` (`SaleEnded`).
6. `[-]` Rejection when purchasing while sale is paused (`SalePaused`).
7. `[-]` Rejection when purchase quantity exceeds available `allocation` (`AllocationExceeded`).
8. `[-]` Rejection when purchase quantity pushes buyer past `per_wallet_max` (`PerWalletMaxExceeded`).
9. `[+]` Admin ability to toggle pause state on and off.
10. `[+]` Admin ability to withdraw remaining tokens after `end_ts`.
11. `[-]` Rejection of non-admin signatures on `withdraw_unsold`.
12. `[-]` Rejection of withdrawal attempts before `end_ts` has passed (`SaleNotEnded`).

---

## 10. Live Devnet Deployment & Operational Status

The program and sale lifecycle have been fully executed and validated live on Solana Devnet:

| Entity | Address | Details |
|---|---|---|
| **Program ID** | `DVGezEfHU5VwEGekdpc3PnUgUpfX2q6FdisG8hoGdF6c` | Anchor 0.30 SBF program (312,200 bytes) |
| **Token Mint** | `BLytgDiEysfuneo9S1ojCUB3xBm9iJfaQnxATwtai2vu` | Classic SPL Token, 9 decimals, 1,000,000 supply |
| **Mint Authority** | *Permanently Revoked (`None`)* | Fixed supply guaranteed |
| **Sale PDA** | `5sFZnWFF4goHu1WcrNPy9FTrCdjwGXnj2aKSyaSmV2aN` | Seeds: `["sale", mint]`, Bump: 255 |
| **Sale Vault (ATA)** | `2heD5GCoZ2F6eosVFmbhNKkZhmR79sb5vWENkFKBdakF` | Holds active sale token inventory |
| **Admin Wallet** | `A7dsZyqVQWuX72juKW6qD1PyPoNDo4FWWm9boqpYczt9` | Sale operator & authority |
| **Treasury Wallet** | `A7dsZyqVQWuX72juKW6qD1PyPoNDo4FWWm9boqpYczt9` | Direct recipient of purchase SOL payments |

### Verified Devnet Transactions
* **Sale Initialization (`create-sale.ts`)**:
  * Tx Signature: `127SszWaHsG9CqhEq2JZehSLVq3iJTdBxQMg5BAXzvUazLmkqiRHqoyXvTek4i3RaS5DJdtUHUDzbtEiv8dd8wiE`
  * Action: Initialized Sale PDA; deposited 500,000 tokens into Vault ATA.
* **Token Purchase (`buy-tokens.ts`)**:
  * Tx Signature: `2HVEXTdgQrrLuTL1bKJPyhEWrXvkJetFg9B7c1HNXaNZavZGK51xPsEwPoe4bDM6ZCx4FNDtYyxaa5Mk4aJ1UFsV`
  * Action: Purchased 10 whole tokens; paid 0.01 SOL to Treasury; received 10 tokens into Buyer ATA; BuyerStats PDA initialized.
* **Finalize Guard Verification (`finalize-sale.ts`)**:
  * Result: Correctly rejected with on-chain error code `6011` (`SaleNotEnded`), verifying temporal security constraints.
* **Integration Test Suite**:
  * Result: `12 passing (15s)` executed against SBF binary on local validator.
