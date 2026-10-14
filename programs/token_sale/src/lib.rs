use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

declare_id!("DVGezEfHU5VwEGekdpc3PnUgUpfX2q6FdisG8hoGdF6c");

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

#[error_code]
pub enum SaleError {
    #[msg("Price must be greater than zero")]
    InvalidPrice,
    #[msg("start_ts must be before end_ts")]
    InvalidTimeRange,
    #[msg("Allocation must be greater than zero")]
    InvalidAllocation,
    #[msg("Per-wallet max must be greater than zero")]
    InvalidPerWalletMax,
    #[msg("Sale has not started yet")]
    SaleNotStarted,
    #[msg("Sale has ended")]
    SaleEnded,
    #[msg("Sale is paused")]
    SalePaused,
    #[msg("token_amount must be a positive multiple of 10^decimals (whole tokens only)")]
    InvalidTokenAmount,
    #[msg("Exceeds total sale allocation")]
    AllocationExceeded,
    #[msg("Exceeds per-wallet purchase limit")]
    PerWalletMaxExceeded,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Sale has not ended yet")]
    SaleNotEnded,
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

#[program]
pub mod token_sale {
    use super::*;

    /// Creates a new fixed-price token sale.
    ///
    /// The admin deposits `allocation` base-unit tokens into a vault (the
    /// Sale PDA's associated token account).  Buyers will later call `buy`
    /// to purchase whole-token amounts at `price_lamports_per_whole_token`.
    pub fn initialize_sale(
        ctx: Context<InitializeSale>,
        price_lamports_per_whole_token: u64,
        token_decimals: u8,
        start_ts: i64,
        end_ts: i64,
        allocation: u64,
        per_wallet_max: u64,
    ) -> Result<()> {
        // --- validation --------------------------------------------------
        require!(price_lamports_per_whole_token > 0, SaleError::InvalidPrice);
        require!(start_ts < end_ts, SaleError::InvalidTimeRange);
        require!(allocation > 0, SaleError::InvalidAllocation);
        require!(per_wallet_max > 0, SaleError::InvalidPerWalletMax);

        // --- populate Sale state -----------------------------------------
        let sale = &mut ctx.accounts.sale;
        sale.admin = ctx.accounts.admin.key();
        sale.mint = ctx.accounts.mint.key();
        sale.treasury = ctx.accounts.treasury.key();
        sale.price_lamports_per_whole_token = price_lamports_per_whole_token;
        sale.token_decimals = token_decimals;
        sale.start_ts = start_ts;
        sale.end_ts = end_ts;
        sale.allocation = allocation;
        sale.sold = 0;
        sale.per_wallet_max = per_wallet_max;
        sale.paused = false;
        sale.bump = ctx.bumps.sale;

        // --- transfer tokens from admin ATA → vault ----------------------
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.admin_token_account.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.admin.to_account_info(),
                },
            ),
            allocation,
        )?;

        msg!(
            "Sale initialized: {} base-unit tokens at {} lamports/whole-token",
            allocation,
            price_lamports_per_whole_token
        );
        Ok(())
    }

    /// Purchases `token_amount` base-unit tokens from the sale.
    ///
    /// `token_amount` must be a positive multiple of `10^decimals` so that
    /// only whole-token purchases are allowed.  SOL is sent to the treasury
    /// and tokens are transferred from the vault to the buyer's ATA.
    pub fn buy(ctx: Context<Buy>, token_amount: u64) -> Result<()> {
        let sale = &ctx.accounts.sale;

        // --- time window -------------------------------------------------
        let clock = Clock::get()?;
        require!(clock.unix_timestamp >= sale.start_ts, SaleError::SaleNotStarted);
        require!(clock.unix_timestamp < sale.end_ts, SaleError::SaleEnded);
        require!(!sale.paused, SaleError::SalePaused);

        // --- whole-token multiples only ----------------------------------
        let decimals_factor = 10u64
            .checked_pow(sale.token_decimals as u32)
            .ok_or(SaleError::MathOverflow)?;
        require!(
            token_amount > 0 && token_amount % decimals_factor == 0,
            SaleError::InvalidTokenAmount
        );

        // --- allocation cap ----------------------------------------------
        let new_sold = sale
            .sold
            .checked_add(token_amount)
            .ok_or(SaleError::MathOverflow)?;
        require!(new_sold <= sale.allocation, SaleError::AllocationExceeded);

        // --- per-wallet cap ----------------------------------------------
        let buyer_stats = &ctx.accounts.buyer_stats;
        let new_purchased = buyer_stats
            .total_purchased
            .checked_add(token_amount)
            .ok_or(SaleError::MathOverflow)?;
        require!(
            new_purchased <= sale.per_wallet_max,
            SaleError::PerWalletMaxExceeded
        );

        // --- cost calculation (checked) ----------------------------------
        let whole_tokens = token_amount
            .checked_div(decimals_factor)
            .ok_or(SaleError::MathOverflow)?;
        let cost_lamports = whole_tokens
            .checked_mul(sale.price_lamports_per_whole_token)
            .ok_or(SaleError::MathOverflow)?;

        // --- transfer SOL: buyer → treasury ------------------------------
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
            ),
            cost_lamports,
        )?;

        // --- transfer tokens: vault → buyer ATA (PDA signer) -------------
        let mint_key = sale.mint;
        let seeds: &[&[u8]] = &[
            b"sale",
            mint_key.as_ref(),
            &[sale.bump],
        ];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.buyer_token_account.to_account_info(),
                    authority: ctx.accounts.sale.to_account_info(),
                },
                &[seeds],
            ),
            token_amount,
        )?;

        // --- update state ------------------------------------------------
        let sale = &mut ctx.accounts.sale;
        sale.sold = new_sold;

        let buyer_stats = &mut ctx.accounts.buyer_stats;
        // Initialise fields for freshly-created accounts (init_if_needed)
        if buyer_stats.sale == Pubkey::default() {
            buyer_stats.sale = sale.key();
            buyer_stats.buyer = ctx.accounts.buyer.key();
            buyer_stats.bump = ctx.bumps.buyer_stats;
        }
        buyer_stats.total_purchased = new_purchased;

        msg!(
            "Bought {} base-unit tokens for {} lamports",
            token_amount,
            cost_lamports
        );
        Ok(())
    }

    /// Toggles the `paused` flag on the sale.  Admin-only.
    pub fn toggle_pause(ctx: Context<TogglePause>) -> Result<()> {
        let sale = &mut ctx.accounts.sale;
        sale.paused = !sale.paused;
        msg!("Sale paused = {}", sale.paused);
        Ok(())
    }

    /// Withdraws unsold tokens back to the admin's ATA after the sale ends.
    pub fn withdraw_unsold(ctx: Context<WithdrawUnsold>) -> Result<()> {
        let sale = &ctx.accounts.sale;

        let clock = Clock::get()?;
        require!(clock.unix_timestamp >= sale.end_ts, SaleError::SaleNotEnded);

        let remaining = sale
            .allocation
            .checked_sub(sale.sold)
            .ok_or(SaleError::MathOverflow)?;

        if remaining == 0 {
            msg!("No unsold tokens to withdraw");
            return Ok(());
        }

        let mint_key = sale.mint;
        let seeds: &[&[u8]] = &[
            b"sale",
            mint_key.as_ref(),
            &[sale.bump],
        ];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.admin_token_account.to_account_info(),
                    authority: ctx.accounts.sale.to_account_info(),
                },
                &[seeds],
            ),
            remaining,
        )?;

        msg!("Withdrew {} unsold base-unit tokens", remaining);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Account contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(
    price_lamports_per_whole_token: u64,
    token_decimals: u8,
    start_ts: i64,
    end_ts: i64,
    allocation: u64,
    per_wallet_max: u64,
)]
pub struct InitializeSale<'info> {
    /// The sale admin who deposits tokens and controls the sale.
    #[account(mut)]
    pub admin: Signer<'info>,

    /// The SPL token mint being sold.
    pub mint: Account<'info, Mint>,

    /// Sale PDA – seeded by ["sale", mint].
    #[account(
        init,
        payer = admin,
        space = 8 + Sale::INIT_SPACE,
        seeds = [b"sale", mint.key().as_ref()],
        bump,
    )]
    pub sale: Account<'info, Sale>,

    /// Treasury wallet that receives SOL payments.
    /// CHECK: This is simply the SOL recipient; no data is read/written.
    pub treasury: UncheckedAccount<'info>,

    /// Admin's associated token account (source of allocation tokens).
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = admin,
    )]
    pub admin_token_account: Account<'info, TokenAccount>,

    /// Vault – the Sale PDA's associated token account that holds sale tokens.
    #[account(
        init,
        payer = admin,
        associated_token::mint = mint,
        associated_token::authority = sale,
    )]
    pub vault: Account<'info, TokenAccount>,

    // Programs
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Buy<'info> {
    /// The buyer purchasing tokens.
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// The Sale PDA (mutable – we update `sold`).
    #[account(
        mut,
        seeds = [b"sale", sale.mint.as_ref()],
        bump = sale.bump,
        has_one = mint,
        has_one = treasury,
    )]
    pub sale: Account<'info, Sale>,

    /// The SPL token mint being sold.
    pub mint: Account<'info, Mint>,

    /// Treasury that receives SOL.
    /// CHECK: Validated via has_one on sale.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,

    /// Vault – the Sale PDA's ATA holding sale tokens.
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = sale,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// Buyer's associated token account (receives purchased tokens).
    #[account(
        init_if_needed,
        payer = buyer,
        associated_token::mint = mint,
        associated_token::authority = buyer,
    )]
    pub buyer_token_account: Account<'info, TokenAccount>,

    /// Per-buyer statistics PDA – tracks cumulative purchases.
    #[account(
        init_if_needed,
        payer = buyer,
        space = 8 + BuyerStats::INIT_SPACE,
        seeds = [b"buyer", sale.key().as_ref(), buyer.key().as_ref()],
        bump,
    )]
    pub buyer_stats: Account<'info, BuyerStats>,

    // Programs
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct TogglePause<'info> {
    /// Admin – must match the admin stored in the Sale PDA.
    pub admin: Signer<'info>,

    /// The Sale PDA (mutable – we flip `paused`).
    #[account(
        mut,
        has_one = admin,
        seeds = [b"sale", sale.mint.as_ref()],
        bump = sale.bump,
    )]
    pub sale: Account<'info, Sale>,
}

#[derive(Accounts)]
pub struct WithdrawUnsold<'info> {
    /// Admin – must match the admin stored in the Sale PDA.
    #[account(mut)]
    pub admin: Signer<'info>,

    /// The Sale PDA.
    #[account(
        mut,
        has_one = admin,
        has_one = mint,
        seeds = [b"sale", sale.mint.as_ref()],
        bump = sale.bump,
    )]
    pub sale: Account<'info, Sale>,

    /// The SPL token mint.
    pub mint: Account<'info, Mint>,

    /// Vault – the Sale PDA's ATA.
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = sale,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// Admin's ATA that receives the unsold tokens.
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = admin,
    )]
    pub admin_token_account: Account<'info, TokenAccount>,

    // Programs
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Sale {
    /// The admin who created and controls this sale.
    pub admin: Pubkey,
    /// The SPL token mint being sold.
    pub mint: Pubkey,
    /// The wallet that receives SOL payments from buyers.
    pub treasury: Pubkey,
    /// Price in lamports for one whole token (10^decimals base units).
    pub price_lamports_per_whole_token: u64,
    /// Number of decimals the token mint uses.
    pub token_decimals: u8,
    /// Unix timestamp when the sale opens.
    pub start_ts: i64,
    /// Unix timestamp when the sale closes.
    pub end_ts: i64,
    /// Total token allocation for this sale (in base units).
    pub allocation: u64,
    /// Tokens sold so far (in base units).
    pub sold: u64,
    /// Maximum tokens any single wallet may purchase (in base units).
    pub per_wallet_max: u64,
    /// Whether the sale is currently paused.
    pub paused: bool,
    /// PDA bump seed.
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct BuyerStats {
    /// The Sale PDA this record belongs to.
    pub sale: Pubkey,
    /// The buyer's wallet address.
    pub buyer: Pubkey,
    /// Cumulative tokens purchased by this buyer (in base units).
    pub total_purchased: u64,
    /// PDA bump seed.
    pub bump: u8,
}
