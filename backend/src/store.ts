// Persistence boundary.
//
// The API talks to this interface, never to SQL directly, so route behaviour
// can be tested exhaustively without a live Postgres while production still
// runs against the real schema in migrations/001_init.sql.
//
// No method here accepts key material. The types simply have nowhere to put a
// secret, which is the point.

import { randomUUID, randomBytes } from "node:crypto";

import type { CoordinationCounts } from "./admin.js";

export type DraftStatus = "draft" | "ready" | "created" | "abandoned";

export interface DraftSlot {
  /**
   * Stable identity for this place, assigned once and never changed.
   *
   * slot_index is a POSITION and is renumbered by every reorder, so it can
   * never identify a place. This id is what keeps an invite link, and the
   * person it was sent to, attached to the same seat however the order moves.
   */
  slotId: string;
  slotIndex: number;
  inviteToken: string;
  memberRef: string | null;
  authPublicKey: string | null;
  acceptedByAddress: string | null;
  acceptedAt: string | null;
}

export interface CircleDraft {
  id: string;
  chainId: string;
  organizerAddress: string;
  token: string;
  contributionAmount: string;
  cadenceSeconds: number;
  graceSeconds: number;
  memberCount: number;
  status: DraftStatus;
  circleId: number | null;
  createdTx: string | null;
  createdAt: string;
  slots: DraftSlot[];
}

export interface IndexedCircle {
  chainId: string;
  circleId: number;
  contributionAmount: string;
  token: string;
  memberLimit: number;
  joinedCount: number;
  currentRound: number;
  status: string;
  updatedAt: string;
}

export interface CircleEvent {
  chainId: string;
  blockNumber: number;
  txHash: string;
  eventIndex: number;
  eventName: string;
  circleId: number | null;
  round: number | null;
  memberRef: string | null;
  status: string | null;
}

export interface CreateDraftInput {
  chainId: string;
  organizerAddress: string;
  token: string;
  contributionAmount: string;
  cadenceSeconds: number;
  graceSeconds: number;
  memberCount: number;
}

export interface AcceptInput {
  inviteToken: string;
  memberRef: string;
  authPublicKey: string;
  address: string;
}

export type AcceptResult =
  | { ok: true; draft: CircleDraft; slotIndex: number }
  | { ok: false; reason: "unknown_invite" | "already_accepted" | "duplicate_member" | "draft_closed" };

/** How a wallet is connected to a circle. Organizing wins over holding a place. */
export type AssociationRole = "organizer" | "member";

/**
 * One wallet's connection to one circle.
 *
 * Deliberately a summary and not a draft. It answers "is this mine, what are
 * the terms, and has it been created yet" and nothing else: no invite token, no
 * other member's commitment, address or key. A wallet learns about its own
 * place and the circle's public terms, which is all any screen needs.
 */
export interface CircleAssociation {
  draftId: string;
  role: AssociationRole;
  /** This wallet has taken a place. True for an organizer who also joined. */
  accepted: boolean;
  chainId: string;
  token: string;
  contributionAmount: string;
  cadenceSeconds: number;
  graceSeconds: number;
  memberCount: number;
  acceptedCount: number;
  status: DraftStatus;
  /** Set once creation has been verified against the chain. */
  circleId: number | null;
  createdAt: string;
  /** When this wallet took its place, if it has. */
  acceptedAt: string | null;
}

// --- Chain-neutral member <-> account binding ---
//
// Separate from CircleDraft/DraftSlot on purpose: those are Starknet-shaped
// (an on-chain integer circle id, a felt member commitment and settlement
// key). A binding's circleId/memberRef/chain/account are opaque strings any
// chain adapter can format, matching core/accountBinding.ts's
// MemberAccountBinding on the frontend.

export interface AccountBinding {
  circleId: string;
  memberRef: string;
  chain: string;
  account: string;
  boundAt: string;
}

export interface CreateAccountBindInviteInput {
  circleId: string;
  memberRef: string;
  chain: string;
}

export type CreateAccountBindInviteResult =
  | { ok: true; inviteToken: string }
  | { ok: false; reason: "already_invited" };

export interface AcceptAccountBindInput {
  inviteToken: string;
  account: string;
}

/**
 * memberRef/circleId/chain are never taken from the caller here — they come
 * from whichever invite the token resolves to. A client cannot choose which
 * member it is binding; it can only accept the one place its token names.
 */
export type AcceptAccountBindResult =
  | { ok: true; binding: AccountBinding }
  | { ok: false; reason: "unknown_invite" | "already_used" | "already_bound" };

// --- Celo circle organizer authority ---
//
// First-claim, then immutable: see migrations/003_celo_circle_organizers.sql.

export type EstablishCeloOrganizerResult =
  | { ok: true; organizer: string }
  | { ok: false; reason: "wrong_organizer" };

export interface Store {
  createDraft(input: CreateDraftInput): Promise<CircleDraft>;
  getDraft(id: string): Promise<CircleDraft | null>;
  getDraftByInviteToken(token: string): Promise<CircleDraft | null>;
  listDraftsByOrganizer(address: string): Promise<CircleDraft[]>;
  /** Every circle this wallet organizes or holds a place in. */
  listAssociationsForAddress(address: string): Promise<CircleAssociation[]>;
  acceptInvite(input: AcceptInput): Promise<AcceptResult>;
  /** `order` lists every slot id of the draft exactly once, in the new payout order. */
  reorderSlots(id: string, order: string[]): Promise<CircleDraft | null>;
  markCreated(id: string, circleId: number, txHash: string | null): Promise<CircleDraft | null>;
  abandonDraft(id: string): Promise<CircleDraft | null>;

  /**
   * Records `organizer` as the circle's organizer if none is recorded yet,
   * or confirms it matches the one already recorded. Never overwrites a
   * different existing organizer.
   */
  establishCeloCircleOrganizer(circleId: string, organizer: string): Promise<EstablishCeloOrganizerResult>;
  /** Mints a single-use token that may bind exactly this (circleId, memberRef). */
  createAccountBindInvite(input: CreateAccountBindInviteInput): Promise<CreateAccountBindInviteResult>;
  /** Consumes an invite token, writing the binding it names. Never replaces an existing binding. */
  acceptAccountBind(input: AcceptAccountBindInput): Promise<AcceptAccountBindResult>;
  /** The durable fact, or null if this member has no registered account yet. */
  getAccountBinding(circleId: string, memberRef: string): Promise<AccountBinding | null>;

  upsertIndexedCircle(circle: Omit<IndexedCircle, "updatedAt">): Promise<void>;
  listIndexedCircles(chainId: string): Promise<IndexedCircle[]>;
  recordEvents(events: CircleEvent[]): Promise<number>;
  listEventsForCircle(chainId: string, circleId: number): Promise<CircleEvent[]>;

  getCursor(name: string): Promise<number | null>;
  setCursor(name: string, chainId: string, block: number): Promise<void>;

  /**
   * Aggregate coordination counts, for the operator dashboard.
   *
   * Counts and two timestamps. It returns no draft, no slot, no address, no
   * invitation token and no circle membership, so an operator can see that four
   * drafts are waiting without learning anything about whose they are. Every
   * figure comes from a column that already exists.
   */
  coordinationCounts(chainId: string): Promise<CoordinationCounts>;

  healthy(): Promise<boolean>;
}

/** URL-safe, unguessable coordination token. Not a credential. */
export function newInviteToken(): string {
  return randomBytes(24).toString("base64url");
}

/** A draft becomes ready exactly when every reserved slot is accepted. */
export function deriveStatus(draft: CircleDraft): DraftStatus {
  if (draft.status === "created" || draft.status === "abandoned") return draft.status;
  const accepted = draft.slots.filter((s) => s.memberRef !== null).length;
  return accepted === draft.memberCount ? "ready" : "draft";
}

/**
 * One wallet's view of one draft.
 *
 * The projection lives here so both stores answer identically, and so the
 * fields that are deliberately absent are absent in one place: no invite
 * token, and nobody else's commitment, key or address.
 */
export function associationFor(draft: CircleDraft, address: string): CircleAssociation {
  const mine = draft.slots.find((s) => s.acceptedByAddress === address) ?? null;
  return {
    draftId: draft.id,
    role: draft.organizerAddress === address ? "organizer" : "member",
    accepted: mine !== null,
    chainId: draft.chainId,
    token: draft.token,
    contributionAmount: draft.contributionAmount,
    cadenceSeconds: draft.cadenceSeconds,
    graceSeconds: draft.graceSeconds,
    memberCount: draft.memberCount,
    acceptedCount: draft.slots.filter((s) => s.memberRef !== null).length,
    status: draft.status,
    circleId: draft.circleId,
    createdAt: draft.createdAt,
    acceptedAt: mine?.acceptedAt ?? null,
  };
}

/** Newest first, so the circle someone is most likely looking for is at the top. */
export function byNewestFirst(a: CircleAssociation, b: CircleAssociation): number {
  return b.createdAt.localeCompare(a.createdAt);
}

// --- In-memory implementation, used by tests ---

export class MemoryStore implements Store {
  private drafts = new Map<string, CircleDraft>();
  private circles = new Map<string, IndexedCircle>();
  private events: CircleEvent[] = [];
  private cursors = new Map<string, { chainId: string; block: number }>();
  private bindInvites = new Map<
    string,
    { circleId: string; memberRef: string; chain: string; inviteToken: string; usedAt: string | null }
  >();
  private bindings = new Map<string, AccountBinding>();
  private celoOrganizers = new Map<string, string>();

  async createDraft(input: CreateDraftInput): Promise<CircleDraft> {
    const draft: CircleDraft = {
      id: randomUUID(),
      ...input,
      status: "draft",
      circleId: null,
      createdTx: null,
      createdAt: new Date().toISOString(),
      slots: Array.from({ length: input.memberCount }, (_, slotIndex) => ({
        slotId: randomUUID(),
        slotIndex,
        inviteToken: newInviteToken(),
        memberRef: null,
        authPublicKey: null,
        acceptedByAddress: null,
        acceptedAt: null,
      })),
    };
    this.drafts.set(draft.id, draft);
    return structuredClone(draft);
  }

  async getDraft(id: string): Promise<CircleDraft | null> {
    const d = this.drafts.get(id);
    return d ? structuredClone(d) : null;
  }

  async getDraftByInviteToken(token: string): Promise<CircleDraft | null> {
    for (const d of this.drafts.values()) {
      if (d.slots.some((s) => s.inviteToken === token)) return structuredClone(d);
    }
    return null;
  }

  async listDraftsByOrganizer(address: string): Promise<CircleDraft[]> {
    return [...this.drafts.values()]
      .filter((d) => d.organizerAddress === address)
      .map((d) => structuredClone(d));
  }

  async listAssociationsForAddress(address: string): Promise<CircleAssociation[]> {
    return [...this.drafts.values()]
      .filter(
        (d) =>
          d.organizerAddress === address ||
          d.slots.some((s) => s.acceptedByAddress === address),
      )
      .map((d) => associationFor(d, address))
      .sort(byNewestFirst);
  }

  async acceptInvite(input: AcceptInput): Promise<AcceptResult> {
    for (const draft of this.drafts.values()) {
      const slot = draft.slots.find((s) => s.inviteToken === input.inviteToken);
      if (!slot) continue;
      if (draft.status === "created" || draft.status === "abandoned") {
        return { ok: false, reason: "draft_closed" };
      }
      if (slot.memberRef !== null) return { ok: false, reason: "already_accepted" };
      // One commitment may hold at most one place in a circle: a duplicate in
      // the payout order would be an invalid circle on chain.
      if (draft.slots.some((s) => s.memberRef === input.memberRef)) {
        return { ok: false, reason: "duplicate_member" };
      }
      slot.memberRef = input.memberRef;
      slot.authPublicKey = input.authPublicKey;
      slot.acceptedByAddress = input.address;
      slot.acceptedAt = new Date().toISOString();
      draft.status = deriveStatus(draft);
      return { ok: true, draft: structuredClone(draft), slotIndex: slot.slotIndex };
    }
    return { ok: false, reason: "unknown_invite" };
  }

  async reorderSlots(id: string, order: string[]): Promise<CircleDraft | null> {
    const draft = this.drafts.get(id);
    if (!draft) return null;
    // Every place of this draft, exactly once. Anything else is refused rather
    // than partially applied: a payout order is not something to guess at.
    if (new Set(order).size !== order.length) return null;
    if (order.length !== draft.slots.length) return null;
    const reordered = order.map((slotId) => draft.slots.find((s) => s.slotId === slotId));
    if (reordered.some((s) => s === undefined)) return null;
    // Positions are rewritten; identity, invite token and member travel with
    // the slot itself.
    draft.slots = (reordered as DraftSlot[]).map((s, idx) => ({ ...s, slotIndex: idx }));
    return structuredClone(draft);
  }

  async markCreated(id: string, circleId: number, txHash: string | null): Promise<CircleDraft | null> {
    const draft = this.drafts.get(id);
    if (!draft) return null;
    draft.circleId = circleId;
    draft.createdTx = txHash;
    draft.status = "created";
    return structuredClone(draft);
  }

  async abandonDraft(id: string): Promise<CircleDraft | null> {
    const draft = this.drafts.get(id);
    if (!draft) return null;
    draft.status = "abandoned";
    return structuredClone(draft);
  }

  async establishCeloCircleOrganizer(
    circleId: string,
    organizer: string,
  ): Promise<EstablishCeloOrganizerResult> {
    const existing = this.celoOrganizers.get(circleId);
    if (existing === undefined) {
      this.celoOrganizers.set(circleId, organizer);
      return { ok: true, organizer };
    }
    if (existing === organizer) return { ok: true, organizer };
    return { ok: false, reason: "wrong_organizer" };
  }

  private static bindKey(circleId: string, memberRef: string): string {
    return `${circleId} ${memberRef}`;
  }

  async createAccountBindInvite(
    input: CreateAccountBindInviteInput,
  ): Promise<CreateAccountBindInviteResult> {
    const key = MemoryStore.bindKey(input.circleId, input.memberRef);
    if (this.bindInvites.has(key)) return { ok: false, reason: "already_invited" };
    const inviteToken = newInviteToken();
    this.bindInvites.set(key, { ...input, inviteToken, usedAt: null });
    return { ok: true, inviteToken };
  }

  async acceptAccountBind(input: AcceptAccountBindInput): Promise<AcceptAccountBindResult> {
    const entry = [...this.bindInvites.values()].find((i) => i.inviteToken === input.inviteToken);
    if (entry === undefined) return { ok: false, reason: "unknown_invite" };
    if (entry.usedAt !== null) return { ok: false, reason: "already_used" };
    const key = MemoryStore.bindKey(entry.circleId, entry.memberRef);
    if (this.bindings.has(key)) return { ok: false, reason: "already_bound" };

    entry.usedAt = new Date().toISOString();
    const binding: AccountBinding = {
      circleId: entry.circleId,
      memberRef: entry.memberRef,
      chain: entry.chain,
      account: input.account,
      boundAt: entry.usedAt,
    };
    this.bindings.set(key, binding);
    return { ok: true, binding };
  }

  async getAccountBinding(circleId: string, memberRef: string): Promise<AccountBinding | null> {
    return this.bindings.get(MemoryStore.bindKey(circleId, memberRef)) ?? null;
  }

  async upsertIndexedCircle(circle: Omit<IndexedCircle, "updatedAt">): Promise<void> {
    this.circles.set(`${circle.chainId}:${circle.circleId}`, {
      ...circle,
      updatedAt: new Date().toISOString(),
    });
  }

  async listIndexedCircles(chainId: string): Promise<IndexedCircle[]> {
    return [...this.circles.values()]
      .filter((c) => c.chainId === chainId)
      .sort((a, b) => a.circleId - b.circleId);
  }

  async recordEvents(events: CircleEvent[]): Promise<number> {
    let inserted = 0;
    for (const e of events) {
      const dup = this.events.some(
        (x) => x.chainId === e.chainId && x.txHash === e.txHash && x.eventIndex === e.eventIndex,
      );
      if (dup) continue;
      this.events.push(e);
      inserted += 1;
    }
    return inserted;
  }

  async listEventsForCircle(chainId: string, circleId: number): Promise<CircleEvent[]> {
    return this.events
      .filter((e) => e.chainId === chainId && e.circleId === circleId)
      .sort((a, b) => a.blockNumber - b.blockNumber || a.eventIndex - b.eventIndex);
  }

  async getCursor(name: string): Promise<number | null> {
    return this.cursors.get(name)?.block ?? null;
  }

  async setCursor(name: string, chainId: string, block: number): Promise<void> {
    this.cursors.set(name, { chainId, block });
  }

  async coordinationCounts(chainId: string): Promise<CoordinationCounts> {
    const drafts = [...this.drafts.values()];
    const live = drafts.filter((d) => d.status !== "abandoned");
    const withStatus = (s: DraftStatus) => drafts.filter((d) => d.status === s);

    const recorded = new Set(
      drafts.filter((d) => d.circleId !== null).map((d) => d.circleId as number),
    );
    const indexed = [...this.circles.values()].filter((c) => c.chainId === chainId);

    const oldest = (list: CircleDraft[]): string | null =>
      list.length === 0
        ? null
        : list.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b)).createdAt;

    return {
      draftsTotal: drafts.length,
      draftsCollecting: withStatus("draft").length,
      draftsReady: withStatus("ready").length,
      draftsCreated: withStatus("created").length,
      draftsAbandoned: withStatus("abandoned").length,
      placesTotal: live.reduce((n, d) => n + d.memberCount, 0),
      placesAccepted: live.reduce(
        (n, d) => n + d.slots.filter((s) => s.memberRef !== null).length,
        0,
      ),
      createdWithoutCircleId: withStatus("created").filter((d) => d.circleId === null).length,
      indexedCircles: indexed.length,
      unrecordedChainCircles: indexed.filter((c) => !recorded.has(c.circleId)).length,
      oldestCollectingAt: oldest(withStatus("draft")),
      oldestReadyAt: oldest(withStatus("ready")),
    };
  }

  async healthy(): Promise<boolean> {
    return true;
  }
}
