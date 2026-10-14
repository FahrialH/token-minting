import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { Connection, Keypair, clusterApiUrl, Commitment } from "@solana/web3.js";

// Load .env from project root
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

/**
 * Typed configuration object derived from environment variables.
 */
export interface Config {
  adminKeypairPath: string;
  solanaCluster: string;
  tokenDecimals: number;
  totalSupply: number;
  revokeMintAuthority: boolean;
  saleAllocation: number;
  priceLamportsPerWholeToken: number;
  perWalletMaxTokens: number;
  saleDurationSeconds: number;
  treasuryPubkey: string;
  mintAddress: string;
}

/**
 * Reads and returns all configuration values from environment variables.
 * Throws if required variables are missing or invalid.
 */
export function getConfig(): Config {
  const adminKeypairPath = process.env.ADMIN_KEYPAIR_PATH || "~/.config/solana/id.json";
  const solanaCluster = process.env.SOLANA_CLUSTER || "devnet";
  const tokenDecimals = parseInt(process.env.TOKEN_DECIMALS || "9", 10);
  const totalSupply = parseInt(process.env.TOTAL_SUPPLY || "1000000", 10);
  const revokeMintAuthority = (process.env.REVOKE_MINT_AUTHORITY || "true").toLowerCase() === "true";
  const saleAllocation = parseInt(process.env.SALE_ALLOCATION || "500000", 10);
  const priceLamportsPerWholeToken = parseInt(process.env.PRICE_LAMPORTS_PER_WHOLE_TOKEN || "1000000", 10);
  const perWalletMaxTokens = parseInt(process.env.PER_WALLET_MAX_TOKENS || "10000", 10);
  const saleDurationSeconds = parseInt(process.env.SALE_DURATION_SECONDS || "86400", 10);
  const treasuryPubkey = process.env.TREASURY_PUBKEY || "";
  const mintAddress = process.env.MINT_ADDRESS || "";

  if (isNaN(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 18) {
    throw new Error(`Invalid TOKEN_DECIMALS: ${process.env.TOKEN_DECIMALS}`);
  }
  if (isNaN(totalSupply) || totalSupply <= 0) {
    throw new Error(`Invalid TOTAL_SUPPLY: ${process.env.TOTAL_SUPPLY}`);
  }

  return {
    adminKeypairPath,
    solanaCluster,
    tokenDecimals,
    totalSupply,
    revokeMintAuthority,
    saleAllocation,
    priceLamportsPerWholeToken,
    perWalletMaxTokens,
    saleDurationSeconds,
    treasuryPubkey,
    mintAddress,
  };
}

/**
 * Resolves a file path, expanding the `~` home directory shorthand.
 */
function resolvePath(filePath: string): string {
  if (filePath.startsWith("~")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return path.join(home, filePath.slice(1));
  }
  return path.resolve(filePath);
}

/**
 * Loads a Solana Keypair from a JSON file on disk.
 * The file should contain a JSON array of 64 bytes (secret key).
 *
 * @param keypairPath - Path to the keypair JSON file
 * @returns The loaded Keypair
 */
export function loadKeypair(keypairPath: string): Keypair {
  const resolved = resolvePath(keypairPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Keypair file not found: ${resolved}`);
  }
  const raw = fs.readFileSync(resolved, "utf-8");
  const secretKey = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secretKey);
}

/**
 * Creates and returns a Solana Connection to the configured cluster.
 * Supports "devnet", "testnet", "mainnet-beta", and "localhost".
 *
 * @returns A Connection instance
 */
export function getConnection(): Connection {
  const config = getConfig();
  const cluster = config.solanaCluster;

  let endpoint: string;
  if (cluster === "localhost" || cluster === "localnet") {
    endpoint = "http://127.0.0.1:8899";
  } else if (cluster === "devnet" || cluster === "testnet" || cluster === "mainnet-beta") {
    endpoint = clusterApiUrl(cluster);
  } else {
    // Treat as custom RPC URL
    endpoint = cluster;
  }

  console.log(`Connecting to Solana cluster: ${cluster} (${endpoint})`);
  return new Connection(endpoint, "confirmed");
}

/**
 * Confirms a transaction on-chain with the specified commitment level.
 * Throws if the transaction fails or times out.
 *
 * @param connection - Solana RPC connection
 * @param signature - Transaction signature to confirm
 * @param commitment - Commitment level (default: "confirmed")
 */
export async function confirmTx(
  connection: Connection,
  signature: string,
  commitment: Commitment = "confirmed"
): Promise<void> {
  console.log(`Confirming transaction: ${signature}`);

  const latestBlockhash = await connection.getLatestBlockhash(commitment);
  const confirmation = await connection.confirmTransaction(
    {
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    },
    commitment
  );

  if (confirmation.value.err) {
    throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }

  console.log(`Transaction confirmed: ${signature}`);
}

/**
 * Converts a whole-token amount to base units (lamports equivalent for the token).
 *
 * @param wholeTokens - Number of whole tokens
 * @param decimals - Token decimal places
 * @returns The amount in base units as a bigint
 */
export function toBaseUnits(wholeTokens: number, decimals: number): bigint {
  return BigInt(wholeTokens) * BigInt(10 ** decimals);
}

/**
 * Formats a base-unit amount back to a human-readable whole-token string.
 *
 * @param baseUnits - Amount in base units
 * @param decimals - Token decimal places
 * @returns Formatted string
 */
export function fromBaseUnits(baseUnits: bigint | number, decimals: number): string {
  const divisor = BigInt(10 ** decimals);
  const bu = BigInt(baseUnits);
  const whole = bu / divisor;
  const remainder = bu % divisor;
  if (remainder === BigInt(0)) {
    return whole.toString();
  }
  const remainderStr = remainder.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${remainderStr}`;
}
