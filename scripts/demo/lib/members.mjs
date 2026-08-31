// Demo member identities.
//
// IWA membership is a felt commitment, never a Starknet address, so one
// operator account can hold every demo member identity without weakening
// anything: the contract binds obligations and payouts to `member_ref` and to
// the auth key registered with it, not to whoever submits the transaction.
//
// Each member needs two secrets, both environment-only:
//   IWA_MEMBER_<L>_SECRET            the invite secret (a felt)
//   IWA_MEMBER_<L>_AUTH_PRIVATE_KEY  the Stark-curve settlement signing key
//
// member_ref = poseidon([IWA_INVITE_V1, secret, auth_public_key]), so a leaked
// secret alone matches no slot.

import { secretFelt, secretPrivateKey } from "./secrets.mjs";
import { deriveMember } from "./circle.mjs";

export function memberLabel(index) {
  return String.fromCharCode(65 + index);
}

/** Loads exactly `count` member identities, failing closed on any missing secret. */
export function loadMembers(count) {
  const members = [];
  for (let i = 0; i < count; i += 1) {
    const label = memberLabel(i);
    members.push(
      deriveMember(
        label,
        secretFelt(`IWA_MEMBER_${label}_SECRET`),
        secretPrivateKey(`IWA_MEMBER_${label}_AUTH_PRIVATE_KEY`)
      )
    );
  }

  const refs = new Set(members.map((m) => m.memberRef.toString()));
  if (refs.size !== members.length) {
    throw new Error("two demo members produced the same member_ref — their secrets collide");
  }
  return members;
}

export function findMember(members, label) {
  const m = members.find((x) => x.label === label.toUpperCase());
  if (!m) throw new Error(`no such demo member: ${label} (have ${members.map((x) => x.label).join(", ")})`);
  return m;
}
