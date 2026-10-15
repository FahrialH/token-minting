# Solana Fixed-Price Token Sale — Mainnet Deployment & Launch Guide

This guide provides the complete, production-grade instructions for deploying the **Solana Fixed-Price Token Sale** program, minting tokens with permanent Metaplex metadata, and launching the sales on **Solana Mainnet-Beta**.

---

## 1. Prerequisites & Preparation Checklist

Before touching real funds or deploying to Mainnet, verify every item below:

### A. Dedicated Private RPC Endpoint (Critical)
> [!CAUTION]
> **Do NOT use public RPC (`https://api.mainnet-beta.solana.com`) for Mainnet deployment or sales.** Public endpoints have strict rate limits, frequently drop deployment transaction chunks, and will fail during high-traffic token sales.

Obtain a dedicated Mainnet RPC from an enterprise provider:
* **Helius** (Recommended for Solana): [https://helius.dev/](https://helius.dev/)
* **QuickNode**: [https://quicknode.com/](https://quicknode.com/)
* **Triton / RPC Pool**: [https://triton.one/](https://triton.one/)

### B. Wallet & Key Management
1. **Never Reuse Devnet Keys**: Generate fresh, isolated keypairs for Mainnet.
2. **Deployer / Admin Keypair**:
   * Generates the program, token mints, and sale PDAs.
   * Store securely in an encrypted filesystem or dedicated hardware environment.
3. **Treasury Address (SOL Destination)**:
   * **Best Practice**: Use a **Squads Protocol Multi-Sig** ([https://squads.so/](https://squads.so/)) or a Ledger Hardware Wallet as the `TREASURY_PUBKEY`.
   * Ensures collected SOL proceeds cannot be compromised by a single private key leak.

### C. SOL Funding & Cost Estimates (Mainnet-Beta)

| Operation | Purpose | Estimated Cost |
|---|---|---|
| **Program Deployment** | Rent exemption for 312,200 byte SBF binary | ~1.60 SOL |
| **On-Chain IDL Initialization** | Stores Anchor IDL on-chain for explorers | ~0.15 SOL |
| **Token Creation (per token)** | Mint account, Admin ATA, Metaplex metadata account | ~0.025 SOL |
| **Sale Creation (per sale)** | Sale PDA, Vault ATA, token deposit rent | ~0.025 SOL |
| **Buffer / Transaction Fees** | Network priority fees during congestion | ~0.50 SOL |
| **Total Recommended Balance** | Funded on Deployer Wallet | **~2.50 to 3.00 SOL** |

---

## 2. Permanent Metadata Hosting (Arweave / IPFS)

On Devnet, hosting JSON and images on GitHub was acceptable. On Mainnet, token logos and metadata **must be permanently immutable and decentralized**.

### Recommended Hosting Services:
1. **Arweave via Irys (formerly Bundlr)**: Permanent, one-time payment decentralized storage.
2. **Pinata (IPFS)**: Reliable IPFS pinning service ([https://pinata.cloud/](https://pinata.cloud/)).

### Standard JSON Schema (`metadata.json`):
```json
{
  "name": "CYRUS",
  "symbol": "CRS",
  "description": "CYRUS is a blockchain-based token within the ID-OPENTECH ecosystem, connecting movement, energy generation, and Web3 rewards.",
  "image": "https://arweave.net/<TRANSACTION_ID_OR_HASH>/logo.png",
  "external_url": "https://cyruslab.io",
  "attributes": [
    { "trait_type": "Blockchain", "value": "Solana" },
    { "trait_type": "Ecosystem", "value": "ID-OPENTECH" },
    { "trait_type": "Token Type", "value": "Utility" },
    { "trait_type": "Total Supply", "value": "3000000000" }
  ],
  "properties": {
    "files": [
      {
        "uri": "https://arweave.net/<TRANSACTION_ID_OR_HASH>/logo.png",
        "type": "image/png"
      }
    ],
    "category": "image"
  }
}
```

---

## 3. Step-by-Step Mainnet Deployment Guide

### Step 1: Create Mainnet Deploy Keypair
If you want a dedicated Program ID keypair for Mainnet:
```bash
# Generate keypair inside target/deploy/
solana-keygen new -o target/deploy/token_sale_mainnet-keypair.json --no-bip39-passphrase
```
Get the Program ID:
```bash
solana address --keypair target/deploy/token_sale_mainnet-keypair.json
```

### Step 2: Synchronize Program ID Across Codebase
Update the Program ID in these 3 files:
1. `programs/token_sale/src/lib.rs`:
   ```rust
   declare_id!("YOUR_MAINNET_PROGRAM_ID");
   ```
2. `Anchor.toml`:
   ```toml
   [programs.mainnet]
   token_sale = "YOUR_MAINNET_PROGRAM_ID"
   ```
3. `target/idl/token_sale.json`:
   ```json
   "address": "YOUR_MAINNET_PROGRAM_ID"
   ```

### Step 3: Compile Deterministic SBF Binary
Compile using Docker for reproducible bytecode:
```powershell
docker run --rm -v "${PWD}:/work" -w /work backpackapp/build:v0.30.1 anchor build --no-idl
```
Ensure the compiled binary is staged at `target/deploy/token_sale.so`.

### Step 4: Deploy the Program to Mainnet-Beta
Deploy using your dedicated RPC endpoint and funded admin keypair:
```powershell
docker run --rm `
  -v "C:/Users/fahri/.config/solana:/root/.config/solana:ro" `
  -v "${PWD}:/work" `
  -w /work backpackapp/build:v0.30.1 `
  solana program deploy /work/target/deploy/token_sale.so `
    --program-id /work/target/deploy/token_sale_mainnet-keypair.json `
    --keypair /root/.config/solana/mainnet-admin.json `
    --url "https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY"
```

### Step 5: Initialize the IDL on Mainnet
Publish the IDL to the blockchain so Solscan, Solana Explorer, and wallets automatically decode instruction arguments (`Buy`, `InitializeSale`) and account schemas:
```powershell
docker run --rm `
  -v "C:/Users/fahri/.config/solana:/root/.config/solana:ro" `
  -v "${PWD}:/work" `
  -w /work backpackapp/build:v0.30.1 `
  anchor idl init -f /work/target/idl/token_sale.json `
    YOUR_MAINNET_PROGRAM_ID `
    --provider.cluster "https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY" `
    --provider.wallet /root/.config/solana/mainnet-admin.json
```

---

## 4. Configuring Mainnet Environment Files

Create `.env.mainnet` (or configure `.env`):

```ini
# Mainnet RPC & Security
SOLANA_CLUSTER=https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY
ADMIN_KEYPAIR_PATH=C:\Users\fahri\.config\solana\mainnet-admin.json

# Treasury Address (Multi-Sig or Cold Storage)
TREASURY_PUBKEY=YOUR_SQUADS_MULTISIG_OR_COLD_WALLET

# Token Settings (Example: CYRUS)
TOKEN_NAME="CYRUS"
TOKEN_SYMBOL="CRS"
TOKEN_METADATA_URI="https://arweave.net/YOUR_METADATA_HASH/cyrus-token.json"
TOKEN_DECIMALS=9
TOTAL_SUPPLY=3000000000
REVOKE_MINT_AUTHORITY=true

# Sale Settings
SALE_ALLOCATION=1500000000
PRICE_LAMPORTS_PER_WHOLE_TOKEN=1000000
PER_WALLET_MAX_TOKENS=5000000
SALE_DURATION_SECONDS=604800

# Generated after create-token runs
MINT_ADDRESS=
```

---

## 5. Token Minting & Sale Lifecycle Execution

### Step 1: Mint the Token
```powershell
$env:ENV_FILE=".env.mainnet"; npm run create-token
```
* Creates classic SPL token with 9 decimals and exact supply.
* Publishes Metaplex Metadata account (`metaqbxx...`).
* Permanently revokes mint authority (verifiably fixed supply).
* Outputs `MINT_ADDRESS`. Copy this into `.env.mainnet`.

### Step 2: Initialize the Sale
```powershell
$env:ENV_FILE=".env.mainnet"; npm run create-sale
```
* Creates the deterministic `["sale", mint]` PDA.
* Creates the PDA-owned token Vault ATA.
* Deposits the configured `SALE_ALLOCATION` from Admin ATA to the Vault.
* Starts the sale clock (`start_ts` to `end_ts`).

### Step 3: Verify with Balance Inspector
```powershell
$env:ENV_FILE=".env.mainnet"; npm run check-balance
```
* Displays live on-chain balances for Admin, Vault, and Treasury.

---

## 6. Post-Launch Operations & Security Whitelisting

### A. Blowfish / Solflare Whitelisting
To prevent the *"Scam site detected"* automated warning when users connect their wallets to your frontend on Mainnet:
1. Ensure your dApp domain uses SSL (`https://`).
2. Go to **[https://blowfish.xyz/](https://blowfish.xyz/)** and click **Report False Positive / Submit Whitelist**.
3. Provide:
   * Your custom dApp domain (e.g. `launchpad.id-opentech.com`).
   * Program ID: `YOUR_MAINNET_PROGRAM_ID`.
   * Token Mint addresses.
4. Once approved, Blowfish removes warnings across Phantom and Solflare.

### B. Jupiter Strict List & DEX Indexing
* Once the token sale completes or reaches target distribution, you can provision initial liquidity on **Raydium** (CPMM or AMM v4) or **Meteora**.
* Submit your token metadata to the **Jupiter Token List** repository ([https://github.com/jup-ag/token-list](https://github.com/jup-ag/token-list)) to enable search-by-symbol on Jupiter aggregator.

---

## 7. Emergency Controls & Finalization

### Pausing the Sale (Emergency Freeze)
If unusual activity occurs, the admin can immediately toggle the sale paused state on-chain:
```typescript
await program.methods.togglePause().accounts({ admin, sale }).rpc();
```
* While paused, all buyer purchase transactions are instantly rejected by the smart contract (`SalePaused`).

### Reclaiming Unsold Tokens (Post-Sale Window)
Once `SALE_DURATION_SECONDS` has elapsed:
```powershell
$env:ENV_FILE=".env.mainnet"; npm run finalize-sale
```
* On-chain contract validates `Clock::get()?.unix_timestamp >= sale.end_ts`.
* Transfers all remaining unsold tokens from the Sale PDA Vault back to the Admin ATA.
* Sale proceeds (SOL) have already arrived safely in the Treasury.
