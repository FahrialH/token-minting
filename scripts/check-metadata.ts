import { Connection, PublicKey } from '@solana/web3.js';
import { PROGRAM_ID as METAPLEX_PROGRAM_ID } from '@metaplex-foundation/mpl-token-metadata';

async function main() {
  const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
  const mints = [
    { name: 'Cyrus', mint: 'GwYCf9z39AEnDregxXRktgKeKPAGXpkJcJUUTScVhWhE' },
    { name: 'EV-GO', mint: 'Gxv4uRGqTu1u3YQ78CLj44EnBH75j3RTqY3hx9ez7KJg' },
    { name: 'Intyfe', mint: 'FKF1p2SpEkEZqGsNdFcznBvWCZModBTLtVeQhgE4mozX' }
  ];

  for (const item of mints) {
    const mintPubkey = new PublicKey(item.mint);
    const [metadataPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('metadata'), METAPLEX_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()],
      METAPLEX_PROGRAM_ID
    );
    const info = await conn.getAccountInfo(metadataPda);
    console.log('=== ' + item.name + ' ===');
    console.log('Metadata PDA:', metadataPda.toBase58());
    if (!info) {
      console.log('NO METADATA ACCOUNT FOUND!');
      continue;
    }
    // Parse raw buffer strings
    const buf = info.data;
    // Metaplex format: key(1), update_auth(32), mint(32), name(4+len), symbol(4+len), uri(4+len)
    let offset = 1 + 32 + 32;
    const nameLen = buf.readUInt32LE(offset); offset += 4;
    const name = buf.slice(offset, offset + nameLen).toString('utf8').replace(/\0/g, ''); offset += nameLen;
    const symbolLen = buf.readUInt32LE(offset); offset += 4;
    const symbol = buf.slice(offset, offset + symbolLen).toString('utf8').replace(/\0/g, ''); offset += symbolLen;
    const uriLen = buf.readUInt32LE(offset); offset += 4;
    const uri = buf.slice(offset, offset + uriLen).toString('utf8').replace(/\0/g, '');
    console.log('Name:', name);
    console.log('Symbol:', symbol);
    console.log('On-Chain URI:', uri);
  }
}
main();
