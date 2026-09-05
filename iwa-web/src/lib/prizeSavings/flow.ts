// features/prizeSavings/flow.ts — the screen's state machine, pure and
// testable. The screen renders what this says and calls what this names;
// nothing here talks to a chain or a wallet.

export type FlowStage =
  | "walletMissing"
  | "connect" // not connected to an Ethereum wallet
  | "wrongNetwork" // connected, but not Sepolia
  | "load" // connected and on Sepolia: reading the pool
  | "loadFailed"
  | "open" // round Open: wrap, operator, deposit
  | "locked"
  | "drawn"
  | "claimable"
  | "unknown";

export interface PoolFacts {
  roundState: "Open" | "Locked" | "Drawn" | "Claimable";
  participantCount: number;
  maxParticipants: number;
  isParticipant: boolean;
  hasClaimed: boolean;
  isOwner: boolean;
  operatorGranted: boolean;
}

export interface FlowInput {
  wallet: "missing" | "disconnected" | "wrongNetwork" | "connected";
  onSepolia: boolean;
  facts: PoolFacts | null;
  loadFailed: boolean;
}

export function stageOf(input: FlowInput): FlowStage {
  if (input.wallet === "missing") return "walletMissing";
  if (input.wallet === "disconnected") return "connect";
  if (input.wallet === "wrongNetwork" || !input.onSepolia) return "wrongNetwork";
  if (input.loadFailed) return "loadFailed";
  if (input.facts === null) return "load";
  return input.facts.roundState.toLowerCase() as FlowStage;
}

/** What the deposit area may offer, given where the round is. */
export interface DepositOffer {
  canDeposit: boolean;
  canWithdraw: boolean;
  reason: string | null;
}

export function depositOffer(stage: FlowStage): DepositOffer {
  switch (stage) {
    case "open":
      return { canDeposit: true, canWithdraw: true, reason: null };
    case "locked":
    case "drawn":
    case "claimable":
      return {
        canDeposit: false,
        canWithdraw: true,
        reason: "This round has closed to new deposits. Your principal stays withdrawable.",
      };
    default:
      return { canDeposit: false, canWithdraw: false, reason: null };
  }
}

export interface ClaimOffer {
  canClaim: boolean;
  claimLabel: string;
  reason: string | null;
}

export function claimOffer(facts: PoolFacts | null): ClaimOffer {
  if (facts === null) return { canClaim: false, claimLabel: "Claim", reason: null };
  if (facts.roundState === "Claimable" || facts.roundState === "Drawn") {
    if (!facts.isParticipant) {
      return { canClaim: false, claimLabel: "Claim", reason: "Only participants can claim." };
    }
    if (facts.hasClaimed) {
      return { canClaim: false, claimLabel: "Claimed", reason: "You already claimed this round." };
    }
    return { canClaim: true, claimLabel: "Claim", reason: null };
  }
  return {
    canClaim: false,
    claimLabel: "Claim",
    reason: "Claims open after the draw.",
  };
}

/** What the owner area may offer, given where the round is. */
export interface OwnerOffer {
  isOwner: boolean;
  canFund: boolean;
  canLock: boolean;
  canDraw: boolean;
}

export function ownerOffer(facts: PoolFacts | null): OwnerOffer {
  if (facts === null) return { isOwner: false, canFund: false, canLock: false, canDraw: false };
  return {
    isOwner: facts.isOwner,
    canFund: facts.isOwner && facts.roundState === "Open",
    canLock: facts.isOwner && facts.roundState === "Open",
    canDraw: facts.isOwner && facts.roundState === "Locked",
  };
}

/** Formats a raw 6-decimal unit amount for display. */
export function formatUnits6(raw: bigint): string {
  const whole = raw / 1000000n;
  const frac = raw % 1000000n;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(6, "0").replace(/0+$/, "")}`;
}

/** Parses a user-entered 6-decimal amount into raw units. */
export function parseUnits6(input: string): bigint | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{0,6})?$/.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  return BigInt(whole) * 1000000n + BigInt(frac.padEnd(6, "0") || "0");
}

/** Copy for the feature. Product-first; Zama acknowledged only as the layer. */
export const PRIZE_SAVINGS_COPY = {
  eyebrow: "Iwa Prize Savings",
  heading: "Save privately. Keep your principal. Earn a chance at shared rewards.",
  intro:
    "Deposit confidentially into a shared pool, keep every unit of your principal withdrawable, and let a verifiable draw choose who receives this round's reward. Your balance is encrypted on chain and decryptable only by you.",
  privacyNote:
    "Deposits, balances and the winner stay encrypted. Participation is public; amounts are not. Confidentiality is provided by Zama's fhEVM.",
  connect: "Connect an Ethereum wallet to take part.",
  wrongNetwork: "Iwa Prize Savings runs on Ethereum Sepolia. Switch networks to continue.",
  getTokens: "Get test MockUSD",
  getTokensDetail: "Testnet token with an open mint, so you can try the flow freely.",
  wrap: "Wrap into confidential cMockUSD",
  wrapDetail: "This is the only public amount. After this step, your balance is encrypted.",
  grantOperator: "Allow the pool to move your wrapped tokens",
  grantOperatorDetail: "The pool needs operator permission to pull deposits. It cannot see your balance.",
  deposit: "Deposit",
  depositDetail: "Your deposit amount stays encrypted.",
  balance: "Your confidential balance",
  balanceDetail: "Decrypted only on your device, through a signature you approve.",
  withdraw: "Withdraw",
  withdrawAll: "Withdraw all",
  fundPrize: "Fund this round's reward",
  lockRound: "Lock the round",
  draw: "Run the draw",
  claim: "Claim",
  ownerOnly: "Only the pool owner sees these controls.",
  locked: "The round is locked. The draw is coming.",
  drawn: "The draw is done. Claims are open.",
  claimable: "Claims are open.",
  roundOpen: "The round is open for deposits.",
  noWinner: "This round had no winner - the reward rolls over, untouched.",
  techNote: "Confidentiality layer: Zama fhEVM on Ethereum Sepolia.",
};