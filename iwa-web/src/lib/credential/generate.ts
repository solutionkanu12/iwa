// lib/credential/generate.ts — Portable Trust Credential V2 generation.
//
// A credential is only ever issued for a claim that ALREADY holds on chain,
// checked with the exact same predicate the verifier uses
// (`evaluateClaimOnChain`). The generator additionally refuses to sign for a
// circle the identity is not a member of, or with a key the circle does not
// recognise — so a produced artifact is one the verifier will accept.
//
// No amounts, balances, other members, or history are read or emitted; the
// output is the canonical `iwa-credential/2` artifact and nothing else.

import type { MemberIdentity } from "../../chains/strk20/iwaSigning";
import { feltHex } from "../../chains/strk20/iwaSigning";
import { buildCredentialArtifactV2, type CredentialArtifactV2 } from "./artifact";
import type { ClaimType } from "./claims";
import { evaluateClaimOnChain, type CredentialChainReader } from "./verify";

export interface GenerateCredentialArgsV2 {
  identity: MemberIdentity;
  claimType: ClaimType;
  /** Good Standing only; ignored (normalised to 0) for circle_completion. */
  thresholdRounds?: number;
  network: string;
  circleId: number;
  chain: CredentialChainReader;
  iwaCircleV2: string;
  issuedAtBlock: number;
  issuedAt: number;
}

export type GenerateResultV2 =
  | { ok: true; artifact: CredentialArtifactV2 }
  | { ok: false; reason: string };

function feltEq(a: string | bigint, b: string | bigint): boolean {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
}

export async function generateCredentialV2(
  args: GenerateCredentialArgsV2,
): Promise<GenerateResultV2> {
  const memberRef = feltHex(args.identity.memberRef);

  try {
    const onchainKey = await args.chain.getMemberAuthKey(args.circleId, memberRef);
    if (onchainKey === 0n || !(await args.chain.isMember(args.circleId, memberRef))) {
      return { ok: false, reason: "this identity is not a member of the circle" };
    }
    if (!feltEq(onchainKey, args.identity.authPublicKeyX)) {
      return { ok: false, reason: "this identity's key is not the member's on-chain key" };
    }

    const failure = await evaluateClaimOnChain(args.chain, {
      claimType: args.claimType,
      thresholdRounds: args.thresholdRounds ?? 0,
      circleId: args.circleId,
      memberRef,
    });
    if (failure) {
      return { ok: false, reason: failure.reason ?? "the claim does not hold on chain" };
    }
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `could not confirm the claim on chain: ${m}` };
  }

  const artifact = buildCredentialArtifactV2({
    identity: args.identity,
    claimType: args.claimType,
    thresholdRounds: args.thresholdRounds,
    network: args.network,
    circleId: args.circleId,
    iwaCircleV2: args.iwaCircleV2,
    issuedAtBlock: args.issuedAtBlock,
    issuedAt: args.issuedAt,
  });
  return { ok: true, artifact };
}
