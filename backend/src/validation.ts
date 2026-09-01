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
