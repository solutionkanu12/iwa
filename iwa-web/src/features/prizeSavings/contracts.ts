// features/prizeSavings/contracts.ts — the Iwa Prize Savings contract surface
// over the deployed Sepolia addresses, typed minimally.
//
// Every call that changes state goes through the visitor's own wallet
// (ethers BrowserProvider over window.ethereum): this module never holds a
// key, never signs, and never exposes a ciphertext or a decrypted value.

import { BrowserProvider, Contract } from "ethers";
import { eip1193Provider } from "../../chains/ethereum/wallet";
import { IWA_PRIZE_SAVINGS } from "../../chains/ethereum/config";

const MOCK_USD_ABI = [
  "function mint(address to, uint256 amount)",
  "function balanceOf(address account) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
] as const;

const CMOCK_USD_ABI = [
  "function wrap(address to, uint256 amount)",
  "function setOperator(address operator, uint48 until)",
  "function isOperator(address holder, address spender) view returns (bool)",
  "function confidentialBalanceOf(address account) view returns (bytes32)",
  "function rate() view returns (uint256)",
] as const;

// Multi-round pool ABI. Saving (deposit/withdraw) is lifetime and
// round-independent; joining a round (joinRound) is a separate, explicit
// action; claiming names the round it claims (claim(roundId)), since a
// round's own draw/claim history stays valid forever, no matter how many
// later rounds have opened since (see IwaPrizeSavings.sol).
const POOL_ABI = [
  "function deposit(bytes32 amount, bytes inputProof)",
  "function withdraw(bytes32 amount, bytes inputProof)",
  "function withdrawAll()",
  "function fundPrize(bytes32 amount, bytes inputProof)",
  "function joinRound()",
  "function lockRound()",
  "function draw()",
  "function claim(uint256 roundId)",
  "function currentRoundId() view returns (uint256)",
  "function roundState() view returns (uint8)",
  "function roundStateOf(uint256 roundId) view returns (uint8)",
  "function owner() view returns (address)",
  "function isParticipant(address) view returns (bool)",
  "function isParticipantInRound(uint256 roundId, address user) view returns (bool)",
  "function hasClaimedRound(uint256 roundId, address user) view returns (bool)",
  "function participantCount() view returns (uint256)",
  "function confidentialBalanceOf(address) view returns (bytes32)",
  "function prizeReserve() view returns (bytes32)",
  "function MAX_PARTICIPANTS() view returns (uint256)",
  "function MAX_POOL_TOTAL() view returns (uint256)",
  "function DRAW_TIMEOUT() view returns (uint256)",
  "function lockTimestamp() view returns (uint256)",
] as const;

export type RoundState = "Open" | "Locked" | "Drawn" | "Claimable";

export function roundStateName(state: number): RoundState {
  switch (state) {
    case 0:
      return "Open";
    case 1:
      return "Locked";
    case 2:
      return "Drawn";
    case 3:
      return "Claimable";
    default:
      return "Open";
  }
}

/** The zero address, which a never-written encrypted balance starts as. */
export const ZERO_HANDLE =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

function poolContract(address?: string): Contract | null {
  const provider = eip1193Provider();
  if (provider === null) return null;
  return new Contract(address ?? IWA_PRIZE_SAVINGS.IwaPrizeSavings, POOL_ABI, new BrowserProvider(provider));
}

/** Read-only views against the deployed pool. All facts here describe the
 *  CURRENT round; a finished round's own facts are read separately (see
 *  readLastRound), since they must stay valid after later rounds open. */
export async function readPool(address?: string) {
  const pool = poolContract(address);
  if (pool === null) throw new Error("No Ethereum wallet found in this browser");
  const [currentRoundId, roundState, owner, participantCount, maxParticipants, maxPoolTotal, drawTimeout] =
    await Promise.all([
      pool.currentRoundId(),
      pool.roundState(),
      pool.owner(),
      pool.participantCount(),
      pool.MAX_PARTICIPANTS(),
      pool.MAX_POOL_TOTAL(),
      pool.DRAW_TIMEOUT(),
    ]);
  return {
    currentRoundId: Number(currentRoundId),
    roundState: roundStateName(Number(roundState)),
    owner: String(owner),
    participantCount: Number(participantCount),
    maxParticipants: Number(maxParticipants),
    maxPoolTotal: Number(maxPoolTotal),
    drawTimeout: Number(drawTimeout),
  };
}

export async function readUserState(user: string, address?: string) {
  const pool = poolContract(address);
  if (pool === null) throw new Error("No Ethereum wallet found in this browser");
  const [isParticipantInCurrentRound, credited, lockTimestamp] = await Promise.all([
    pool.isParticipant(user),
    pool.confidentialBalanceOf(user),
    pool.lockTimestamp(),
  ]);
  return {
    isParticipantInCurrentRound: Boolean(isParticipantInCurrentRound),
    // Saving and joining are separate: a live encrypted balance handle means
    // the wallet has saved at least once, which is what makes it eligible
    // to join a round (see IwaPrizeSavings.joinRound).
    hasSavings: String(credited) !== ZERO_HANDLE,
    credited: String(credited),
    lockTimestamp: Number(lockTimestamp),
  };
}

/** The most recently finished round's draw/claim facts for `user`, or null
 *  if no round has finished yet (currentRoundId is still round 1). */
export async function readLastRound(user: string, currentRoundId: number, address?: string) {
  if (currentRoundId <= 1) return null;
  const pool = poolContract(address);
  if (pool === null) throw new Error("No Ethereum wallet found in this browser");
  const lastRoundId = currentRoundId - 1;
  const [state, participated, claimed] = await Promise.all([
    pool.roundStateOf(lastRoundId),
    pool.isParticipantInRound(lastRoundId, user),
    pool.hasClaimedRound(lastRoundId, user),
  ]);
  const stateName = roundStateName(Number(state));
  return {
    roundId: lastRoundId,
    state: (stateName === "Claimable" ? "Claimable" : "Drawn") as "Drawn" | "Claimable",
    participated: Boolean(participated),
    claimed: Boolean(claimed),
  };
}

export async function mintMockUSD(to: string, amount: bigint): Promise<string> {
  const provider = eip1193Provider();
  if (provider === null) throw new Error("No Ethereum wallet found in this browser");
  const signer = await new BrowserProvider(provider).getSigner();
  const mock = new Contract(IWA_PRIZE_SAVINGS.MockUSD, MOCK_USD_ABI, signer);
  const tx = await mock.mint(to, amount);
  await tx.wait();
  return String(tx.hash);
}

export async function wrapMockUSD(to: string, amount: bigint): Promise<string> {
  const provider = eip1193Provider();
  if (provider === null) throw new Error("No Ethereum wallet found in this browser");
  const signer = await new BrowserProvider(provider).getSigner();
  const mock = new Contract(IWA_PRIZE_SAVINGS.MockUSD, MOCK_USD_ABI, signer);
  const approve = await mock.approve(IWA_PRIZE_SAVINGS.CMockUSD, amount);
  await approve.wait();
  const wrapper = new Contract(IWA_PRIZE_SAVINGS.CMockUSD, CMOCK_USD_ABI, signer);
  const wrap = await wrapper.wrap(to, amount);
  await wrap.wait();
  return String(wrap.hash);
}

export async function setOperator(untilSeconds: number): Promise<string> {
  const provider = eip1193Provider();
  if (provider === null) throw new Error("No Ethereum wallet found in this browser");
  const signer = await new BrowserProvider(provider).getSigner();
  const wrapper = new Contract(IWA_PRIZE_SAVINGS.CMockUSD, CMOCK_USD_ABI, signer);
  const tx = await wrapper.setOperator(IWA_PRIZE_SAVINGS.IwaPrizeSavings, untilSeconds);
  await tx.wait();
  return String(tx.hash);
}

export async function isOperator(holder: string): Promise<boolean> {
  const provider = eip1193Provider();
  if (provider === null) return false;
  const wrapper = new Contract(
    IWA_PRIZE_SAVINGS.CMockUSD,
    CMOCK_USD_ABI,
    new BrowserProvider(provider),
  );
  return Boolean(await wrapper.isOperator(holder, IWA_PRIZE_SAVINGS.IwaPrizeSavings));
}

/** The caller's encrypted pool balance handle (opaque ciphertext). */
export async function creditedHandleOf(user: string): Promise<string> {
  const provider = eip1193Provider();
  if (provider === null) throw new Error("No Ethereum wallet found in this browser");
  const pool = new Contract(
    IWA_PRIZE_SAVINGS.IwaPrizeSavings,
    POOL_ABI,
    new BrowserProvider(provider),
  );
  return String(await pool.confidentialBalanceOf(user));
}

/** An encrypted pull or push through the visitor's wallet. */
export async function sendPoolTx(
  method: "deposit" | "withdraw",
  handle: string,
  inputProof: string,
): Promise<string> {
  const provider = eip1193Provider();
  if (provider === null) throw new Error("No Ethereum wallet found in this browser");
  const signer = await new BrowserProvider(provider).getSigner();
  const pool = new Contract(IWA_PRIZE_SAVINGS.IwaPrizeSavings, POOL_ABI, signer);
  const tx = await pool[method](handle, inputProof);
  await tx.wait();
  return String(tx.hash);
}

export async function sendPoolNoArg(
  method: "withdrawAll" | "joinRound",
): Promise<string> {
  const provider = eip1193Provider();
  if (provider === null) throw new Error("No Ethereum wallet found in this browser");
  const signer = await new BrowserProvider(provider).getSigner();
  const pool = new Contract(IWA_PRIZE_SAVINGS.IwaPrizeSavings, POOL_ABI, signer);
  const tx = await pool[method]();
  await tx.wait();
  return String(tx.hash);
}

/** Claims a SPECIFIC round's prize. A round's own claim stays valid no
 *  matter how many later rounds have opened since. */
export async function sendClaim(roundId: number): Promise<string> {
  const provider = eip1193Provider();
  if (provider === null) throw new Error("No Ethereum wallet found in this browser");
  const signer = await new BrowserProvider(provider).getSigner();
  const pool = new Contract(IWA_PRIZE_SAVINGS.IwaPrizeSavings, POOL_ABI, signer);
  const tx = await pool.claim(roundId);
  await tx.wait();
  return String(tx.hash);
}

export async function sendPoolOwnerTx(
  method: "fundPrize",
  handle: string,
  inputProof: string,
): Promise<string> {
  const provider = eip1193Provider();
  if (provider === null) throw new Error("No Ethereum wallet found in this browser");
  const signer = await new BrowserProvider(provider).getSigner();
  const pool = new Contract(IWA_PRIZE_SAVINGS.IwaPrizeSavings, POOL_ABI, signer);
  const tx = await pool[method](handle, inputProof);
  await tx.wait();
  return String(tx.hash);
}

export async function sendPoolOwnerNoArg(method: "lockRound" | "draw"): Promise<string> {
  const provider = eip1193Provider();
  if (provider === null) throw new Error("No Ethereum wallet found in this browser");
  const signer = await new BrowserProvider(provider).getSigner();
  const pool = new Contract(IWA_PRIZE_SAVINGS.IwaPrizeSavings, POOL_ABI, signer);
  const tx = await pool[method]();
  await tx.wait();
  return String(tx.hash);
}

/** Whether the connected wallet is this pool's owner. */
export async function isPoolOwner(wallet: string): Promise<boolean> {
  const { owner } = await readPool();
  return wallet.toLowerCase() === owner.toLowerCase();
}