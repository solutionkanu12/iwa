// Input validation.
//
// Two jobs. First, reject anything malformed before it reaches SQL or the
// chain. Second, and just as important, refuse anything that looks like
// private key material: this service has no custody, so a client that tries to
// send a secret gets an error rather than silent acceptance.

import { z } from "zod";

/** Starknet felts are < 2^252, so a 64-digit value starting above 7 is invalid. */
export const STARK_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;

export function isFelt(value: string): boolean {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(value)) return false;
  try {
    return BigInt(value) < STARK_PRIME;
  } catch {
    return false;
  }
}

/** Normalizes a felt so padded and unpadded forms compare and store identically. */
export function normalizeFelt(value: string): string {
  return `0x${BigInt(value).toString(16)}`;
}

export const felt = z
  .string()
  .refine(isFelt, "must be a Starknet felt below the field prime")
  .transform(normalizeFelt);

export const nonZeroFelt = felt.refine((v) => BigInt(v) !== 0n, "must not be zero");

/** u128 base units as a decimal string. Never a JS number — u128 does not fit. */
function isPositiveU128(value: string): boolean {
  // Guarded: zod runs every check on a schema, so a refine that throws on
  // malformed input escapes the route as a 500 instead of a 400.
  try {
    const n = BigInt(value);
    return n > 0n && n < 1n << 128n;
  } catch {
    return false;
  }
}

export const u128String = z
  .string()
  .regex(/^\d{1,39}$/, "must be a decimal amount in base units")
  .refine(isPositiveU128, "must fit in a positive u128");

export const SN_MAIN = "0x534e5f4d41494e";

export const chainId = z
  .string()
  .refine((v) => isFelt(v) && normalizeFelt(v) === normalizeFelt(SN_MAIN), "only SN_MAIN is supported")
  .transform(normalizeFelt);

/**
 * Field names that must never appear in a request body. Their presence is
 * treated as a client bug or an attack, not as data to ignore, because
 * silently dropping a secret still means it travelled over the network and may
 * sit in a log upstream.
 */
export const FORBIDDEN_FIELDS = [
  "privateKey",
  "private_key",
  "secret",
  "inviteSecret",
  "invite_secret",
  "seed",
  "seedPhrase",
  "mnemonic",
  "viewingKey",
  "viewing_key",
  "authPrivateKey",
  "auth_private_key",
  "signature_s_private",
];

export class ForbiddenFieldError extends Error {
  readonly field: string;
  constructor(field: string) {
    super(
      `the field "${field}" was rejected: this service never receives key material or secrets`,
    );
    this.name = "ForbiddenFieldError";
    this.field = field;
  }
}

/** Recursively refuses secret-shaped fields anywhere in a payload. */
export function assertNoSecrets(body: unknown, depth = 0): void {
  if (depth > 6 || body === null || typeof body !== "object") return;
  if (Array.isArray(body)) {
    for (const item of body) assertNoSecrets(item, depth + 1);
    return;
  }
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    for (const forbidden of FORBIDDEN_FIELDS) {
      if (lower === forbidden.toLowerCase()) throw new ForbiddenFieldError(key);
    }
    assertNoSecrets(value, depth + 1);
  }
}

// --- Request schemas ---

export const createDraftSchema = z.object({
  chainId,
  organizerAddress: nonZeroFelt,
  token: nonZeroFelt,
  contributionAmount: u128String,
  cadenceSeconds: z.number().int().positive().max(31_536_000),
  graceSeconds: z.number().int().positive().max(31_536_000),
  memberCount: z.number().int().min(2).max(32),
});

/**
 * A canonical uuid, as the database stores draft and slot ids.
 *
 * Checked before any lookup so an id that cannot exist is answered as not
 * found rather than being handed to Postgres, which rejects the cast and turns
 * a mistyped link into a server error.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** The shape newInviteToken produces: 24 random bytes, base64url. */
const INVITE_TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

export function isInviteToken(value: string): boolean {
  return INVITE_TOKEN.test(value);
}

/**
 * An acceptance carries only public data: the member's commitment and the
 * public x-coordinate of their settlement key. Both are written to the circle
 * contract when it is created. Nothing private is asked for or accepted.
 */
export const acceptInviteSchema = z.object({
  inviteToken: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/),
  memberRef: nonZeroFelt,
  authPublicKey: nonZeroFelt,
  address: nonZeroFelt,
});

export const reorderSchema = z.object({
  organizerAddress: nonZeroFelt,
  /**
   * Slot IDS in the desired payout order, every place of the draft exactly
   * once. Ids and not positions: a position is renumbered by each reorder, so
   * an order expressed in positions is applied against whatever arrangement
   * the server happens to hold, which is not necessarily the one the organizer
   * was looking at.
   */
  order: z
    .array(z.string().uuid())
    .min(2)
    .max(32)
    .refine((o) => new Set(o).size === o.length, "each place may appear only once"),
});

export const markCreatedSchema = z.object({
  organizerAddress: nonZeroFelt,
  circleId: z.number().int().positive(),
  txHash: felt,
});

// --- Chain-neutral account-binding schemas ---
//
// Unlike every schema above, these are NOT Starknet-specific: `chain` and
// `account` are opaque identifiers a chain adapter formats (e.g.
// "celo:42220" / "celo:0x..."), matching core/accountBinding.ts's
// MemberAccountBinding on the frontend. This service stays chain-neutral
// even though only Celo uses this table today.

export const CHAIN_NEUTRAL_ID = /^[A-Za-z0-9:_-]{1,128}$/;

export const chainNeutralId = z
  .string()
  .regex(CHAIN_NEUTRAL_ID, "must be a short opaque identifier");

export const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export const evmAddress = z.string().regex(EVM_ADDRESS_PATTERN, "must be a 20-byte EVM address");

/**
 * A signed Celo/EVM organizer authorization, carried in the request body
 * rather than headers: a different transport from the Starknet x-iwa-*
 * scheme, on purpose, so the two credential shapes can never be confused for
 * each other by a route that reads the wrong one.
 */
export const celoOrganizerAuthorizationSchema = z.object({
  organizer: evmAddress,
  nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte hex nonce"),
  expiresAt: z.number().int().positive(),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, "must be a 65-byte hex ECDSA signature"),
});

/**
 * Mints a single-use token for exactly one (circleId, memberRef). Naming
 * which chain this invite is for prevents an invite minted for one chain
 * adapter from being silently reused by another.
 *
 * `circleContract` is the deployed IwaCircleCelo address the backend reads
 * `organizer()` from on chain — the actual authorization source. `circleId`
 * remains the chain-neutral, app-level identifier used as the table key
 * (for Celo circles today, that will typically be the same address, but the
 * two are validated and used separately: `circleId` never touches the RPC
 * path).
 *
 * `authorization` is required today because Celo is the only chain that
 * calls this route; a second chain adapter would need its own signed-
 * authorization shape and its own dispatch here, not a relaxation of this
 * one.
 */
export const createAccountBindInviteSchema = z.object({
  circleId: chainNeutralId,
  circleContract: evmAddress,
  memberRef: chainNeutralId,
  chain: chainNeutralId,
  authorization: celoOrganizerAuthorizationSchema,
});

/**
 * circleId/memberRef/chain are deliberately absent: they come from whichever
 * invite the token names, never from the caller. A client cannot choose
 * which member it is binding by supplying one directly.
 */
export const acceptAccountBindSchema = z.object({
  inviteToken: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/),
  account: chainNeutralId,
});

/**
 * Reads one member's binding status. Same organizer-authorization shape as
 * minting an invite (no `chain` field: the status read does not create or
 * touch any binding row, only reports none/invited/bound for the one
 * memberRef named).
 */
export const accountBindingStatusSchema = z.object({
  circleId: chainNeutralId,
  circleContract: evmAddress,
  memberRef: chainNeutralId,
  authorization: celoOrganizerAuthorizationSchema,
});
