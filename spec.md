# Solana Fixed-Price Token Sale — Specification

## Goal
A Devnet-first project that creates a classic SPL token, mints a fixed supply, and sells a configured allocation for SOL at a fixed price. Tokens are delivered immediately after each successful purchase.

## Scope
- TypeScript scripts for mint creation, supply minting, sale initialization, and finalization.
- Rust/Anchor on-chain sale program.
- Fixed-price purchases paid in native SOL.
- Immediate SPL token delivery to the buyer's associated token account (ATA).
- Sale start/end timestamps, total allocation cap, per-wallet cap, pause control, and withdrawal of unsold tokens after sale end.
- Devnet testing and deployment instructions.

## Out of scope
- Token metadata upload / logo hosting.
- Mainnet deployment, DEX listing, liquidity provisioning, fiat payments, vesting, refunds, KYC/allowlists, royalties, and dynamic pricing.
- A website frontend.

## Defaults
- Token program: classic SPL Token (not Token-2022).
- Decimals: configurable; default 9.
- Payment: native SOL.
- Price: integer lamports per whole token.
- Purchase quantities: whole tokens only to avoid rounding ambiguity.
- Delivery: immediate.
- Network: Devnet.
- Mint authority: revoked after the configured supply is minted by default.
- Freeze authority: none.
- Treasury: configured public key; it receives SOL directly in the purchase transaction.

## Architecture
1. `scripts/create-token.ts` creates a mint, creates the operator's ATA, mints a fixed supply, and optionally revokes mint authority.
2. `scripts/create-sale.ts` initializes sale state and the PDA-owned token vault, then transfers the configured sale allocation into the vault.
3. `programs/token_sale/src/lib.rs` validates sale conditions, accepts SOL, updates sale and per-wallet counters, and transfers tokens from the PDA vault to the buyer's ATA.
4. `scripts/finalize-sale.ts` lets the admin withdraw unsold tokens to the admin ATA after the end time. Sale proceeds are already paid directly to the treasury.

## On-chain state
`Sale` PDA seeds: `["sale", mint]`
- admin public key
- mint public key
- treasury public key
- price in lamports per whole token
- token decimals
- start and end Unix timestamps
- allocation in base units
- sold amount in base units
- per-wallet maximum in base units
- paused flag
- bump

`BuyerStats` PDA seeds: `["buyer", sale, buyer]`
- sale public key
- buyer public key
- total purchased in base units
- bump

Token vault: associated token account for the mint with `Sale` PDA as token authority.

## Purchase calculation
The `buy(token_amount)` argument is in base units. The contract requires `token_amount` to be a positive multiple of `10^decimals`, so only whole-token purchases are allowed. Payment is:
`whole_tokens * price_lamports_per_whole_token`.
All arithmetic uses checked operations. The buyer signs the purchase instruction; SOL moves through the System Program and tokens move through the SPL Token Program CPI.

## Security requirements
- Sale state PDA is derived from the mint and cannot be substituted.
- Vault must be the mint's ATA owned by the sale PDA.
- Buyer ATA must be for the configured mint and buyer.
- Treasury is pinned in sale state and cannot be changed by the buyer.
- Sale admin must sign admin-only instructions.
- Reject purchases before start, at/after end, when paused, beyond allocation, or beyond wallet cap.
- Checked arithmetic for payment and counters.
- Use a PDA signer for token transfers.
- No arbitrary CPI targets: use canonical System, Token, and Associated Token programs.
- No private keys committed to source control; use a dedicated Devnet keypair and environment-specific config.
- Test on local validator and Devnet before any real-value deployment.
- Have the program independently reviewed before Mainnet use.

## Acceptance criteria
- Mint script creates a token with configured decimals and supply.
- Mint authority is revoked when `REVOKE_MINT_AUTHORITY=true`.
- Sale initializes only once for a mint.
- Valid purchases pay the configured SOL amount and immediately deliver tokens.
- Invalid purchases fail without partial state changes.
- Allocation and per-wallet limits are enforced.
- Pausing blocks purchases.
- Unsold tokens can only be withdrawn by the admin after sale end.
- Tests cover successful purchase, wrong mint/account constraints, time window, pause, allocation cap, wallet cap, and unsold withdrawal.

## Known limitations / operational notes
- This starter does not publish Metaplex token metadata; wallets may show the mint address without a name/logo until metadata is added.
- Revoking mint authority is irreversible. Decide supply and allocations before revocation.
- This code is a development scaffold, not an audited financial product. Do not use Mainnet funds until builds, tests, deployment, and independent security review are complete.
