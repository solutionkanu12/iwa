// lib/iwaContract.ts — the single seam between the UI and Soroban.
//
// Every contract call goes through here. Bodies are mocked for now: they return
// fake data after a short delay so the screens and motion can be built today.
// When the real contracts land (Stage "wire frontend to real contracts"), only
// this file changes; signatures and return shapes stay exactly as below.

import type { Circle, CircleConfig, Reputation } from "./types";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Fake but well-formed identifiers so UI formatting (mono, truncation) is real.
const fakeHex = (len: number): string => {
  const chars = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * 16)];
  return s;
};
const fakeTxHash = () => fakeHex(64);

// A demo circle: round 3 of 8, amount 50, pot 400 (PRD flow 1).
function mockCircle(id: string): Circle {
  const size = 8;
  const amount = 50;
  const yourSlot = 2;
  const members = Array.from({ length: size }, (_, slot) => ({
    slot,
    filled: slot <= 5, // six of eight seats taken
    isYou: slot === yourSlot,
  }));
  return {
    id,
    amount,
    frequency: 604800, // one week per round, in seconds
    size,
    current_round: 3,
    status: "active",
    pot: amount * size,
    members,
    yourStreak: 3,
  };
}

/** Create a savings circle. */
export async function create_circle(
  _cfg: CircleConfig,
): Promise<{ circleId: string }> {
  await delay(500);
  return { circleId: "circle_" + fakeHex(8) };
}

/** Join a circle. Returns the anonymous slot you were given. */
export async function join_circle(
  _circleId: string,
): Promise<{ ok: boolean; slot: number }> {
  await delay(500);
  return { ok: true, slot: 2 };
}

/** Read the current circle state. */
export async function get_circle(circleId?: string): Promise<Circle> {
  await delay(380);
  return mockCircle(circleId ?? "circle_demo");
}

/**
 * Read the saver's own reputation record. Private to the saver. Real wiring
 * derives this from the savings contract's contribution history; the mock
 * returns a good-standing record (2 cycles, on time, no defaults).
 */
export async function get_reputation(_circleId?: string): Promise<Reputation> {
  await delay(380);
  return { completedCycles: 2, onTimeRate: 100, defaultCount: 0 };
}

/** Pay this round's contribution. */
export async function pay_contribution(
  _circleId: string,
  _round: number,
): Promise<{ ok: boolean; onTime: boolean; txHash: string }> {
  await delay(650);
  return { ok: true, onTime: true, txHash: fakeTxHash() };
}

/** Advance the circle to the next round. */
export async function advance_round(
  _circleId: string,
): Promise<{ ok: boolean }> {
  await delay(500);
  return { ok: true };
}

/** Collect the pot, only valid when it is your turn. */
export async function collect_pot(
  _circleId: string,
): Promise<{ ok: boolean; amount: number; txHash: string }> {
  await delay(650);
  return { ok: true, amount: 400, txHash: fakeTxHash() };
}

/** Verify a proof on Stellar. Output is valid or invalid, nothing personal. */
export async function verify_proof(
  _proof: string,
  _publicSignals: string[],
): Promise<{ verified: boolean; txHash: string; ledger: number }> {
  await delay(900);
  return {
    verified: true,
    txHash: fakeTxHash(),
    ledger: 1_200_000 + Math.floor(Math.random() * 100_000),
  };
}
