// lib/credential/artifact.ts — Portable Trust Credential V2 artifact:
// build + sign, serialise, parse (strict schema validation).
//
// The artifact is signed by the member's IWA auth key (the key registered on
// the V2 circle as `get_member_auth_key(circle, member_ref)`). The signature
// mirrors the Cairo acceptance predicate (`iwaSigning.signChecked` /
// `verifyIwa`), so a credential is refused before it is produced if it would
// not verify.
//
// The V2 identity model as shipped reuses V1's per-member auth key (no separate
// rotatable identity key, no `get_member_v2`). So `iwa-credential/2` binds the
// auth key exactly as V1 would; the design's rotatable-identity-key property is
// NOT available in this release and is documented, not silently assumed.

import {
  feltHex,
  signChecked,
  verifyIwa,
  type IwaRawSignature,
  type MemberIdentity,
} from "../../chains/strk20/iwaSigning";
import {
  CREDENTIAL_SCHEMA_V2,
  credentialHashV2,
  isClaimType,
  normalizeClaim,
  possessionChallengeHashV2,
  type CanonicalCredentialPayloadV2,
  type ClaimType,
  type PossessionChallenge,
} from "./claims";

export interface CredentialSignature {
  /** The public key (x-coordinate) that signed the artifact. 0x-hex felt. */
  signerKey: string;
  r: string;
  s: string;
}

export interface CredentialArtifactV2 extends CanonicalCredentialPayloadV2 {
  signature: CredentialSignature;
}

/** A holder's response to a verifier possession challenge. */
export interface PossessionResponse {
  challenge: PossessionChallenge;
  r: string;
  s: string;
}

export interface BuildCredentialArgsV2 {
  identity: MemberIdentity;
  claimType: ClaimType;
  /** Only used for good_standing; ignored for circle_completion. */
  thresholdRounds?: number;
  network: string;
  circleId: number;
  iwaCircleV2: string;
  issuedAtBlock: number;
  issuedAt: number;
}

/**
 * Builds and signs an `iwa-credential/2` artifact. Does NOT check the claim
 * against chain — that is the generator flow's job (and the verifier's) — but
 * it DOES refuse a signature the chain would reject.
 */
export function buildCredentialArtifactV2(args: BuildCredentialArgsV2): CredentialArtifactV2 {
  const claim = normalizeClaim({
    type: args.claimType,
    params: { thresholdRounds: args.thresholdRounds ?? 0 },
  });
  const payload: CanonicalCredentialPayloadV2 = {
    schema: CREDENTIAL_SCHEMA_V2,
    claim,
    subject: {
      network: args.network,
      circleId: args.circleId,
      memberRef: feltHex(args.identity.memberRef),
    },
    evidence: {
      iwaCircleV2: args.iwaCircleV2,
      issuedAtBlock: args.issuedAtBlock,
      issuedAt: args.issuedAt,
    },
  };
  const hash = credentialHashV2(payload);
  const sig: IwaRawSignature = signChecked(args.identity, hash, "credential v2 artifact");
  return {
    ...payload,
    signature: {
      signerKey: feltHex(args.identity.authPublicKeyX),
      r: feltHex(sig.r),
      s: feltHex(sig.s),
    },
  };
}

/**
 * The holder's answer to a verifier possession challenge: sign
 * `possessionChallengeHashV2` with the SAME auth key that signed the artifact.
 */
export function signPossessionV2(
  identity: MemberIdentity,
  artifact: CredentialArtifactV2,
  challenge: PossessionChallenge,
): PossessionResponse {
  const artifactHash = credentialHashV2(stripSignature(artifact));
  const hash = possessionChallengeHashV2({ artifactHash, challenge });
  const sig = signChecked(identity, hash, "credential v2 possession");
  return { challenge, r: feltHex(sig.r), s: feltHex(sig.s) };
}

export function stripSignature(a: CredentialArtifactV2): CanonicalCredentialPayloadV2 {
  return { schema: a.schema, claim: a.claim, subject: a.subject, evidence: a.evidence };
}

/** Canonical JSON — stable key order — so the same artifact always serialises identically. */
export function serializeArtifactV2(a: CredentialArtifactV2): string {
  const ordered = {
    schema: a.schema,
    claim: { type: a.claim.type, params: { thresholdRounds: a.claim.params.thresholdRounds } },
    subject: { network: a.subject.network, circleId: a.subject.circleId, memberRef: a.subject.memberRef },
    evidence: {
      iwaCircleV2: a.evidence.iwaCircleV2,
      issuedAtBlock: a.evidence.issuedAtBlock,
      issuedAt: a.evidence.issuedAt,
    },
    signature: { signerKey: a.signature.signerKey, r: a.signature.r, s: a.signature.s },
  };
  return JSON.stringify(ordered, null, 2);
}

const MAX_ARTIFACT_BYTES = 4096;
const HEX_FELT = /^0x[0-9a-fA-F]{1,64}$/;

export class ArtifactParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactParseError";
  }
}

/**
 * Strict parse. Every malformed / missing / wrong-typed / oversized field is a
 * hard rejection — an unknown schema version is NEVER reinterpreted.
 */
export function parseArtifactV2(input: string): CredentialArtifactV2 {
  if (typeof input !== "string") throw new ArtifactParseError("artifact must be a string");
  if (input.length > MAX_ARTIFACT_BYTES) {
    throw new ArtifactParseError(`artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
  }
  let o: unknown;
  try {
    o = JSON.parse(input);
  } catch {
    throw new ArtifactParseError("artifact is not valid JSON");
  }
  if (o === null || typeof o !== "object" || Array.isArray(o)) {
    throw new ArtifactParseError("artifact must be a JSON object");
  }
  const a = o as Record<string, unknown>;

  if (a.schema !== CREDENTIAL_SCHEMA_V2) {
    throw new ArtifactParseError(
      `unsupported schema ${JSON.stringify(a.schema)} — only ${CREDENTIAL_SCHEMA_V2} is accepted`,
    );
  }

  const claim = obj(a.claim, "claim");
  if (!isClaimType(claim.type)) throw new ArtifactParseError(`unknown claim.type ${JSON.stringify(claim.type)}`);
  const params = obj(claim.params, "claim.params");
  const thresholdRounds = int(params.thresholdRounds, "claim.params.thresholdRounds");
  if (claim.type === "circle_completion" && thresholdRounds !== 0) {
    throw new ArtifactParseError("circle_completion must have thresholdRounds 0");
  }

  const subject = obj(a.subject, "subject");
  const network = str(subject.network, "subject.network", 31);
  const circleId = int(subject.circleId, "subject.circleId");
  const memberRef = feltStr(subject.memberRef, "subject.memberRef");

  const evidence = obj(a.evidence, "evidence");
  const iwaCircleV2 = feltStr(evidence.iwaCircleV2, "evidence.iwaCircleV2");
  const issuedAtBlock = int(evidence.issuedAtBlock, "evidence.issuedAtBlock");
  const issuedAt = int(evidence.issuedAt, "evidence.issuedAt");

  const signature = obj(a.signature, "signature");
  const signerKey = feltStr(signature.signerKey, "signature.signerKey");
  const r = feltStr(signature.r, "signature.r");
  const s = feltStr(signature.s, "signature.s");

  return {
    schema: CREDENTIAL_SCHEMA_V2,
    claim: { type: claim.type, params: { thresholdRounds } },
    subject: { network, circleId, memberRef },
    evidence: { iwaCircleV2, issuedAtBlock, issuedAt },
    signature: { signerKey, r, s },
  };
}

/**
 * Local mirror of the on-chain acceptance predicate — a `true` here is the same
 * statement the chain would make about the artifact signature.
 */
export function verifyArtifactSignatureV2(a: CredentialArtifactV2): boolean {
  let hash: bigint;
  try {
    hash = credentialHashV2(stripSignature(a));
  } catch {
    return false;
  }
  try {
    return verifyIwa(BigInt(a.signature.signerKey), hash, BigInt(a.signature.r), BigInt(a.signature.s));
  } catch {
    return false;
  }
}

// --- strict field helpers ---

function obj(v: unknown, path: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new ArtifactParseError(`${path} must be an object`);
  }
  return v as Record<string, unknown>;
}

function int(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > Number.MAX_SAFE_INTEGER) {
    throw new ArtifactParseError(`${path} must be a non-negative safe integer`);
  }
  return v;
}

function str(v: unknown, path: string, maxLen: number): string {
  if (typeof v !== "string" || v.length === 0 || v.length > maxLen) {
    throw new ArtifactParseError(`${path} must be a non-empty string ≤ ${maxLen} chars`);
  }
  return v;
}

function feltStr(v: unknown, path: string): string {
  if (typeof v !== "string" || !HEX_FELT.test(v)) {
    throw new ArtifactParseError(`${path} must be a 0x hex felt (≤ 64 hex digits)`);
  }
  try {
    BigInt(v);
  } catch {
    throw new ArtifactParseError(`${path} is not a valid felt`);
  }
  return v;
}
