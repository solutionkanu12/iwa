// features/prizeSavings/flow.ts — the screen's state machine, pure and
// testable. The screen renders what this says and calls what this names;
// nothing here talks to a chain or a wallet.
//
// Multi-round model: the pool runs Round 1, Round 2, Round 3, ... forever.
// "Saving" (deposit/withdraw) and "joining a round" are separate, explicit
// actions - a returning saver is never auto-entered into a new round. The
// current round's own Open/Locked state is what this screen's main stage
// tracks; a completed round's own draw and claim status is tracked
// separately (lastRound), because claiming a finished round stays valid no
// matter how many later rounds have opened since.

export type FlowStage =
  | "walletMissing"
  | "connect" // not connected to an Ethereum wallet
  | "wrongNetwork" // connected, but not Sepolia
  | "load" // connected and on Sepolia: reading the pool
  | "loadFailed"
  | "open" // current round Open: save, join, deposit
  | "locked"
  | "drawn"
  | "claimable"
  | "unknown";

export interface PoolFacts {
  currentRoundId: number;
  roundState: "Open" | "Locked" | "Drawn" | "Claimable";
  participantCount: number;
  maxParticipants: number;
  /** Has the wallet ever saved into the pool (eligible to join a round). */
  hasSavings: boolean;
  isParticipantInCurrentRound: boolean;
  isOwner: boolean;
  operatorGranted: boolean;
}

/** The most recently finished round's draw and claim facts for this wallet. */
export interface LastRoundFacts {
  roundId: number;
  state: "Drawn" | "Claimable";
  participated: boolean;
  claimed: boolean;
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

/** What the deposit area may offer, given where the CURRENT round is. */
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
        reason: "New savings pause briefly while this round finishes. Your savings stay yours and stay withdrawable.",
      };
    default:
      return { canDeposit: false, canWithdraw: false, reason: null };
  }
}

/** Whether the connected wallet may explicitly join the CURRENT round. */
export interface JoinOffer {
  canJoin: boolean;
  alreadyJoined: boolean;
  reason: string | null;
}

export function joinOffer(stage: FlowStage, facts: PoolFacts | null): JoinOffer {
  if (facts === null) return { canJoin: false, alreadyJoined: false, reason: null };
  if (facts.isParticipantInCurrentRound) {
    return { canJoin: false, alreadyJoined: true, reason: null };
  }
  if (stage !== "open") {
    return {
      canJoin: false,
      alreadyJoined: false,
      reason: "Entries are closed for now. The next round opens automatically.",
    };
  }
  if (!facts.hasSavings) {
    return {
      canJoin: false,
      alreadyJoined: false,
      reason: "Add savings first, then join this round.",
    };
  }
  if (facts.participantCount >= facts.maxParticipants) {
    return {
      canJoin: false,
      alreadyJoined: false,
      reason: "This round is full. The next round opens automatically.",
    };
  }
  return { canJoin: true, alreadyJoined: false, reason: null };
}

/** What the claim area may offer for the most recently finished round. */
export interface ClaimOffer {
  visible: boolean;
  canClaim: boolean;
  claimLabel: string;
  message: string | null;
}

export function claimOffer(lastRound: LastRoundFacts | null): ClaimOffer {
  if (lastRound === null || !lastRound.participated) {
    return { visible: false, canClaim: false, claimLabel: "Claim", message: null };
  }
  if (lastRound.claimed) {
    return {
      visible: true,
      canClaim: false,
      claimLabel: "Claimed",
      message: `You already claimed round ${lastRound.roundId}.`,
    };
  }
  return {
    visible: true,
    canClaim: true,
    claimLabel: "Claim",
    message: `The draw for round ${lastRound.roundId} is complete.`,
  };
}

/** What the owner area may offer, given where the CURRENT round is. */
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
    "Deposit confidentially into a shared pool, keep every unit of your principal withdrawable, and join a round for a chance at that round's reward. Your balance is encrypted on chain and decryptable only by you.",
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
  deposit: "Save",
  depositDetail: "Your saved amount stays encrypted.",
  balance: "Your savings",
  balanceDetail: "Decrypted only on your device, through a signature you approve.",
  withdraw: "Withdraw",
  withdrawAll: "Withdraw all",
  fundPrize: "Fund this round's reward",
  lockRound: "Close entries and prepare the draw",
  draw: "Run the draw",
  joinRound: "Join this round",
  joinedRound: "You're in this round",
  claim: "Claim",
  claimed: "Claimed",
  ownerOnly: "Only the pool host sees these controls.",
  locked: "Entries are closed. The draw is coming soon.",
  drawn: "The draw is complete.",
  claimable: "The draw is complete.",
  roundOpen: "Entries are open.",
  noWinner: "This round had no winner. The reward carries forward to the next round, untouched.",
  principalNote: "Your savings stay yours, whether you win or not.",
  techNote: "Confidentiality layer: Zama fhEVM on Ethereum Sepolia.",
};
