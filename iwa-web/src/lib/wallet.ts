// lib/wallet.ts — the first live seam: real Stellar wallet connect and the
// member commitment.
//
// connectWallet opens the Stellar Wallets Kit multi-wallet modal on testnet and
// returns the chosen account's public key. deriveMemberCommitment turns a
// signature over a fixed message into a BN254 field-element secret and commits
// to it with Poseidon, exactly as iwa-circuit does (leaf = Poseidon([secret])),
// yielding the 32-byte big-endian member_commitment that later stages pass to
// the contracts. Contract reads, the prover, and contract writes stay mocked in
// lib/iwaContract.ts and lib/zk.ts this stage.

import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import type { Networks } from "@creit.tech/stellar-wallets-kit";
import { FreighterModule } from "@creit.tech/stellar-wallets-kit/modules/freighter";
import { xBullModule } from "@creit.tech/stellar-wallets-kit/modules/xbull";
import { AlbedoModule } from "@creit.tech/stellar-wallets-kit/modules/albedo";
import { RabetModule } from "@creit.tech/stellar-wallets-kit/modules/rabet";
import { LobstrModule } from "@creit.tech/stellar-wallets-kit/modules/lobstr";
import { HanaModule } from "@creit.tech/stellar-wallets-kit/modules/hana";
import { buildPoseidon, type Poseidon } from "circomlibjs";
import { NETWORK_PASSPHRASE } from "./stellarConfig";
import { fieldToBe32Hex, hexToBytes } from "./convert";

// The wallets offered in the picker. All are Stellar testnet capable; which ones
// appear as available depends on what the visitor has installed or can reach.
function walletModules() {
  return [
    new FreighterModule(),
    new xBullModule(),
    new AlbedoModule(),
    new RabetModule(),
    new LobstrModule(),
    new HanaModule(),
  ];
}

let kitReady = false;
function ensureKit(): void {
  if (kitReady) return;
  // NETWORK_PASSPHRASE is the testnet passphrase, which is exactly the value of
  // the kit's Networks.TESTNET, so this keeps the single source of truth in
  // stellarConfig.ts.
  StellarWalletsKit.init({
    modules: walletModules(),
    network: NETWORK_PASSPHRASE as Networks,
  });
  kitReady = true;
}

// Thrown when the visitor closes the wallet modal without choosing a wallet, so
// the caller can quietly stay on the connect gate.
export class WalletCancelledError extends Error {
  constructor() {
    super("wallet connection cancelled");
    this.name = "WalletCancelledError";
  }
}

/**
 * Open the Stellar Wallets Kit modal, let the visitor pick a wallet, and return
 * the selected account's public key. If they dismiss the modal (or the picked
 * wallet declines), this rejects with WalletCancelledError instead of crashing.
 */
export async function connectWallet(): Promise<string> {
  ensureKit();
  try {
    const { address } = await StellarWalletsKit.authModal();
    return address;
  } catch {
    // The kit rejects when the modal is closed or the connection is declined.
    throw new WalletCancelledError();
  }
}

// A fixed message the wallet signs to derive its secret. The signature is
// deterministic for a Stellar Ed25519 key, so the same wallet always reproduces
// the same secret and the same commitment, and nothing is stored on disk.
const COMMITMENT_MESSAGE = "Iwa member commitment v1";

let poseidonPromise: Promise<Poseidon> | null = null;
function getPoseidon(): Promise<Poseidon> {
  if (!poseidonPromise) poseidonPromise = buildPoseidon();
  return poseidonPromise;
}

export interface MemberCommitment {
  // The private field-element secret, derived from the wallet signature. Held in
  // memory only; never written to disk.
  secret: bigint;
  // Poseidon([secret]) as a field element, identical to iwa-circuit's leaf.
  commitment: bigint;
  // The commitment as 32-byte big-endian hex (64 chars).
  commitmentHex: string;
  // The commitment as raw 32 bytes, the form the contract's member_commitment
  // argument takes.
  commitmentBytes: Uint8Array;
}

// Reduce the signature to a BN254 field element: hash it to 256 bits, then take
// it modulo the field. Deterministic in the signature, so deterministic in the
// wallet.
async function secretFromSignature(
  signedMessage: string,
  field: Poseidon["F"],
): Promise<bigint> {
  const encoded = new TextEncoder().encode(signedMessage);
  // Copy into a concrete ArrayBuffer-backed view so the digest input is a plain
  // BufferSource (TextEncoder output is typed over ArrayBufferLike).
  const bytes = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  bytes.set(encoded);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let acc = 0n;
  for (const b of digest) acc = (acc << 8n) | BigInt(b);
  return acc % field.p;
}

/**
 * Derive this wallet's member_commitment. The wallet signs COMMITMENT_MESSAGE;
 * the signature becomes a field-element secret, which Poseidon commits to the
 * same way iwa-circuit's Reputation template does (leaf = Poseidon(1)([secret])).
 * The result is ready for later stages to pass to join, pay, collect, and the
 * reputation proof.
 */
export async function deriveMemberCommitment(
  address: string,
): Promise<MemberCommitment> {
  const { signedMessage } = await StellarWalletsKit.signMessage(
    COMMITMENT_MESSAGE,
    { address },
  );
  const poseidon = await getPoseidon();
  const secret = await secretFromSignature(signedMessage, poseidon.F);
  const commitment = poseidon.F.toObject(poseidon([secret]));
  const commitmentHex = fieldToBe32Hex(commitment.toString());
  const commitmentBytes = hexToBytes(commitmentHex);
  return { secret, commitment, commitmentHex, commitmentBytes };
}
