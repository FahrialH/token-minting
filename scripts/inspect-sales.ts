import { Connection, PublicKey } from '@solana/web3.js';
import { Program, AnchorProvider } from '@coral-xyz/anchor';
import idl from '../target/idl/token_sale.json';

async function main() {
  const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
  const dummyWallet = { publicKey: PublicKey.default, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t };
  const provider = new AnchorProvider(conn, dummyWallet as any, {});
  const program = new Program(idl as any, provider);

  const sales = [
    { name: 'Cyrus', pda: 'csw4UjNHtftBXaGEEGmtt6DXpwsEAzzk1HJciM7pYvK' },
    { name: 'EV-GO', pda: 'DoJzyEJsQjAmvC7kJm8p9xP1BMajPRB87DYMGP7wDJWW' },
    { name: 'Intyfe', pda: '9YZRMTy6j4hmjFrTKPDkvqg568DGKv9hGTah1obcqwxp' }
  ];

  for (const s of sales) {
    try {
      const acc = await (program.account as any).sale.fetch(new PublicKey(s.pda));
      console.log('=== ' + s.name + ' ===');
      console.log('Mint:', acc.mint.toBase58());
      console.log('Treasury:', acc.treasury.toBase58());
      console.log('Admin:', acc.admin.toBase58());
      console.log('Allocation:', acc.allocation.toString());
      console.log('Sold:', acc.sold.toString());
      console.log('Price lamports:', acc.priceLamportsPerWholeToken.toString());
      console.log('Per wallet max:', acc.perWalletMax.toString());
      console.log('Paused:', acc.paused);
      console.log('StartTs:', new Date(acc.startTs.toNumber() * 1000).toISOString());
      console.log('EndTs:', new Date(acc.endTs.toNumber() * 1000).toISOString());
    } catch (e: any) {
      console.error(s.name, 'fetch error:', e.message);
    }
  }
}
main();
