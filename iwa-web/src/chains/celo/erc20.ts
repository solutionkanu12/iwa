// chains/celo/erc20.ts — ERC-20 encoding for the Celo adapter.
// Calldata only. Sends still go through CeloTransactionAdapter.

import type { HexData } from "./attribution";

const TRANSFER = "a9059cbb";
const APPROVE = "095ea7b3";
const BALANCE_OF = "70a08231";
const ALLOWANCE = "dd62ed3e";

export function encodeTransfer(to: string, amount: bigint): HexData {
  return `0x${TRANSFER}${padAddress(to)}${padUint256(amount)}`;
}

export function encodeApprove(spender: string, amount: bigint): HexData {
  return `0x${APPROVE}${padAddress(spender)}${padUint256(amount)}`;
}

export function encodeBalanceOf(account: string): HexData {
  return `0x${BALANCE_OF}${padAddress(account)}`;
}

export function encodeAllowance(owner: string, spender: string): HexData {
  return `0x${ALLOWANCE}${padAddress(owner)}${padAddress(spender)}`;
}

export function decodeUint256(data: string): bigint {
  if (typeof data !== "string" || !data.startsWith("0x")) {
    throw new Error("Celo read refused: expected hex result");
  }
  if (data === "0x") return 0n;
  return BigInt(data);
}

export function parseBaseUnits(amount: string): bigint {
  if (!/^[0-9]+$/.test(amount)) {
    throw new Error("Celo transaction refused: amount is not a base-unit decimal string");
  }
  const value = BigInt(amount);
  if (value <= 0n) {
    throw new Error("Celo transaction refused: amount must be positive");
  }
  return value;
}

function padAddress(addr: string): string {
  const hex = normalizeAddress(addr).slice(2);
  return hex.padStart(64, "0");
}

function padUint256(amount: bigint): string {
  if (amount < 0n) throw new Error("Celo transaction refused: negative amount");
  const hex = amount.toString(16);
  if (hex.length > 64) throw new Error("Celo transaction refused: amount exceeds uint256");
  return hex.padStart(64, "0");
}

export function normalizeAddress(addr: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    throw new Error("Celo transaction refused: invalid address");
  }
  return `0x${addr.slice(2).toLowerCase()}`;
}

export function sameAddress(a: string, b: string): boolean {
  return normalizeAddress(a) === normalizeAddress(b);
}
