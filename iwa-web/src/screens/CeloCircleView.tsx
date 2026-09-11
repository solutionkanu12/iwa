// screens/CeloCircleView.tsx — a Celo circle, inside the Iwa product shell.
//
// One screen adapts to whoever is looking at it: every connected member
// sees their own contribution obligation, the round's scheduled recipient
// sees a collect action, and the on-chain organizer additionally sees the
// member wallet-binding tools. The chain is the only source of truth for
// round/contribution/payout state; nothing here caches a financial fact
// across a reload. Every send goes through the existing Celo services
// (CeloContributionService, CeloCollectService, CeloRecoverService), which
// route through CeloTransactionAdapter, so the attribution tag and the
// fail-closed account-binding check are never bypassed here.
//
// Recovery: which past rounds are recoverable comes only from
// circleModel's recoverableRounds (on-chain reads plus the Recovered event
// log, never a guess); the round sent to recover() is always one of those,
// never a free-typed number.

import { useCallback, useEffect, useMemo, useState } from "react";

import styles from "./CircleView.module.css";
import { Island } from "../components/Island";
import { Button } from "../components/Button";
import { useWallet } from "../app/WalletProvider";
import { BackendError } from "../lib/backend";
import { formatUnits } from "../chains/strk20/funding";
import { getEthereumProvider } from "../chains/ethereum/wallet";
import { CELO_MAINNET, CNGN_MAINNET } from "../chains/celo/config";
import { CeloCircleReader } from "../chains/celo/circleReader";
import {
  celoDomainCircle,
  celoMyObligation,
  loadCeloCircleContext,
  type CeloCircleContext,
} from "../chains/celo/circleModel";
import { composeCeloContributionService } from "../chains/celo/compose";
import { ContributionHistory } from "../core/contributionHistory";
import { CeloCollectService } from "../chains/celo/collect";
import { CeloRecoverService } from "../chains/celo/recovery";
import type { PreparedCeloContribution } from "../chains/celo/contribution";
import {
  createAccountBindingInvite,
  readAccountBindingStatus,
  type BindingStatus,
} from "../chains/celo/accountBindingsApi";
import { CELO_AUTH_ACTIONS, signOrganizerAuthorization } from "../chains/celo/organizerAuthorization";
import { celoBindInvitePath } from "../lib/router";

function short(address: string): string {
  return `${address.slice(0, 5)}…${address.slice(-4)}`;
}

function humanError(e: unknown): string {
  if (e instanceof BackendError) return e.message;
  if (e instanceof Error) return e.message;
  return "Something went wrong. Please try again.";
}

type WalletGate = "missing" | "disconnected" | "wrongNetwork" | "ready";

function celoGate(status: "missing" | "disconnected" | "wrongNetwork" | "connected"): WalletGate {
  if (status === "connected") return "ready";
  return status;
}

interface RowState {
  status: BindingStatus | "unknown";
  checking: boolean;
  inviting: boolean;
  inviteLink: string | null;
  error: string | null;
}

const EMPTY_ROW: RowState = { status: "unknown", checking: false, inviting: false, inviteLink: null, error: null };

export function CeloCircleView({ circleContract }: { circleContract: string }) {
  const walletManager = useWallet();
  const celo = walletManager.celo;
  const gate = celoGate(celo.status);

  const [ctx, setCtx] = useState<CeloCircleContext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [prepared, setPrepared] = useState<PreparedCeloContribution | null>(null);
  const [contributeBusy, setContributeBusy] = useState<string | null>(null);
  const [contributeError, setContributeError] = useState<string | null>(null);
  const [contributeResult, setContributeResult] = useState<string | null>(null);
  const [notLinked, setNotLinked] = useState(false);

  const [collectBusy, setCollectBusy] = useState(false);
  const [collectError, setCollectError] = useState<string | null>(null);
  const [collectResult, setCollectResult] = useState<string | null>(null);

  const [recoverBusy, setRecoverBusy] = useState<number | null>(null);
  const [recoverError, setRecoverError] = useState<string | null>(null);
  const [recoverResult, setRecoverResult] = useState<string | null>(null);

  const [rows, setRows] = useState<Record<number, RowState>>({});

  // One history per mounted circle screen: it only ever gates a duplicate
  // double-submit inside a single session, never the source of truth for
  // whether a round was actually paid (the chain is).
  const history = useMemo(() => new ContributionHistory(), [circleContract]);

  const load = useCallback(async () => {
    if (gate !== "ready" || celo.address === null) return;
    const provider = getEthereumProvider();
    if (provider === null) return;
    try {
      const reader = new CeloCircleReader(circleContract, provider);
      const next = await loadCeloCircleContext(reader, circleContract, celo.address);
      setCtx(next);
      setLoadError(null);
    } catch (e) {
      setLoadError(humanError(e));
    }
  }, [circleContract, gate, celo.address]);

  useEffect(() => {
    void load();
  }, [load]);

  const onConnect = useCallback(async () => {
    await walletManager.connectCelo();
  }, [walletManager]);

  const onSwitch = useCallback(async () => {
    await walletManager.switchToCeloMainnet();
  }, [walletManager]);

  const onPrepare = useCallback(async () => {
    if (ctx === null || celo.address === null) return;
    setContributeError(null);
    setNotLinked(false);
    setContributeBusy("Checking your contribution");
    try {
      const provider = getEthereumProvider();
      if (provider === null) throw new Error("No wallet found in this browser");
      const circle = celoDomainCircle(ctx);
      const obligation = celoMyObligation(ctx);
      if (obligation === null) {
        throw new Error("This wallet is not a member of this circle.");
      }
      const service = composeCeloContributionService(
        {
          circleId: ctx.circleId,
          chainId: CELO_MAINNET.chainIdNumber,
          token: CNGN_MAINNET.address,
          circleContract: ctx.circleContract,
          contributionAmount: ctx.contributionAmount.toString(),
        },
        provider,
        history,
        celo.address,
      );
      const result = await service.prepare(circle, obligation, celo.address);
      setPrepared(result);
    } catch (e) {
      if (e instanceof Error && /account binding refused/i.test(e.message)) {
        setNotLinked(true);
      } else {
        setContributeError(humanError(e));
      }
    } finally {
      setContributeBusy(null);
    }
  }, [ctx, celo.address, history]);

  const onContribute = useCallback(async () => {
    if (ctx === null || prepared === null || celo.address === null) return;
    setContributeError(null);
    setContributeBusy(
      prepared.requiresOnChainApproval
        ? "Waiting for cNGN approval and contribution in your wallet"
        : "Waiting for your confirmation in your wallet",
    );
    try {
      const provider = getEthereumProvider();
      if (provider === null) throw new Error("No wallet found in this browser");
      const circle = celoDomainCircle(ctx);
      const obligation = celoMyObligation(ctx);
      if (obligation === null) throw new Error("This wallet is not a member of this circle.");
      const service = composeCeloContributionService(
        {
          circleId: ctx.circleId,
          chainId: CELO_MAINNET.chainIdNumber,
          token: CNGN_MAINNET.address,
          circleContract: ctx.circleContract,
          contributionAmount: ctx.contributionAmount.toString(),
        },
        provider,
        history,
        celo.address,
      );
      await service.submit(
        circle,
        obligation,
        prepared,
        { confirmed: true, actionId: prepared.action.actionId },
        Math.floor(Date.now() / 1000),
      );
      setContributeResult("Contribution confirmed.");
      setPrepared(null);
      await load();
    } catch (e) {
      setContributeError(humanError(e));
    } finally {
      setContributeBusy(null);
    }
  }, [ctx, prepared, celo.address, history, load]);

  const onCollect = useCallback(async () => {
    if (ctx === null || celo.address === null) return;
    setCollectError(null);
    setCollectBusy(true);
    try {
      const provider = getEthereumProvider();
      if (provider === null) throw new Error("No wallet found in this browser");
      const service = new CeloCollectService({ circleContract: ctx.circleContract }, provider);
      const result = await service.collect(celo.address);
      if (result.status === "CONFIRMED") {
        setCollectResult("The pot has been sent to this round's scheduled member.");
      } else if (result.status === "PENDING") {
        setCollectError("The collection is still pending confirmation. Refresh in a moment.");
      } else {
        setCollectError("The collection transaction did not succeed. Nothing was moved.");
      }
      await load();
    } catch (e) {
      setCollectError(humanError(e));
    } finally {
      setCollectBusy(false);
    }
  }, [ctx, celo.address, load]);

  const onRecover = useCallback(
    async (round: number) => {
      if (ctx === null || celo.address === null) return;
      setRecoverError(null);
      setRecoverResult(null);
      setRecoverBusy(round);
      try {
        const provider = getEthereumProvider();
        if (provider === null) throw new Error("No wallet found in this browser");
        const service = new CeloRecoverService({ circleContract: ctx.circleContract }, provider);
        const result = await service.recover(celo.address, round);
        if (result.status === "CONFIRMED") {
          setRecoverResult("Your contribution has been returned.");
        } else if (result.status === "PENDING") {
          setRecoverError("The recovery is still pending confirmation. Refresh in a moment.");
        } else {
          setRecoverError("The recovery transaction did not succeed. Nothing was moved.");
        }
        await load();
      } catch (e) {
        setRecoverError(humanError(e));
      } finally {
        setRecoverBusy(null);
      }
    },
    [ctx, celo.address, load],
  );

  const rowFor = (slot: number): RowState => rows[slot] ?? EMPTY_ROW;
  const patchRow = (slot: number, patch: Partial<RowState>) =>
    setRows((current) => ({ ...current, [slot]: { ...rowFor(slot), ...patch } }));

  const onCheckStatus = useCallback(
    async (slot: number, memberRef: string) => {
      if (ctx === null || celo.address === null) return;
      patchRow(slot, { checking: true, error: null });
      try {
        const provider = getEthereumProvider();
        if (provider === null) throw new Error("No wallet found in this browser");
        const authorization = await signOrganizerAuthorization(provider, {
          action: CELO_AUTH_ACTIONS.accountBindingStatus,
          circleId: ctx.circleId,
          circleContract: ctx.circleContract,
          memberRef,
          organizer: celo.address,
        });
        const { status } = await readAccountBindingStatus({
          circleId: ctx.circleId,
          circleContract: ctx.circleContract,
          memberRef,
          authorization,
        });
        patchRow(slot, { status, checking: false });
      } catch (e) {
        patchRow(slot, { checking: false, error: humanError(e) });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx, celo.address],
  );

  const onInvite = useCallback(
    async (slot: number, memberRef: string) => {
      if (ctx === null || celo.address === null) return;
      patchRow(slot, { inviting: true, error: null });
      try {
        const provider = getEthereumProvider();
        if (provider === null) throw new Error("No wallet found in this browser");
        const authorization = await signOrganizerAuthorization(provider, {
          action: CELO_AUTH_ACTIONS.accountBindingInvite,
          circleId: ctx.circleId,
          circleContract: ctx.circleContract,
          memberRef,
          organizer: celo.address,
        });
        const { inviteToken } = await createAccountBindingInvite({
          circleId: ctx.circleId,
          circleContract: ctx.circleContract,
          memberRef,
          chain: `celo:${CELO_MAINNET.chainIdNumber}`,
          authorization,
        });
        const link = `${window.location.origin}${celoBindInvitePath(inviteToken)}`;
        patchRow(slot, { inviting: false, inviteLink: link, status: "invited" });
      } catch (e) {
        patchRow(slot, { inviting: false, error: humanError(e) });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx, celo.address],
  );

  if (gate === "missing") {
    return (
      <Island className={styles.card}>
        <h2 className={styles.h2}>A Celo wallet is needed</h2>
        <p className={styles.meta}>
          This circle settles on Celo. Install a Celo-compatible wallet extension to view or
          take part in it.
        </p>
      </Island>
    );
  }

  if (gate === "disconnected") {
    return (
      <Island className={styles.card}>
        <h2 className={styles.h2}>Connect your Celo wallet</h2>
        <p className={styles.meta}>
          Your place in this circle, and any action you can take, is private to your wallet.
        </p>
        <div className={styles.stack}>
          <Button onClick={() => void onConnect()}>Connect wallet</Button>
        </div>
      </Island>
    );
  }

  if (gate === "wrongNetwork") {
    return (
      <Island className={styles.card}>
        <h2 className={styles.h2}>Switch to Celo mainnet</h2>
        <p className={styles.meta}>This circle only exists on Celo mainnet.</p>
        <div className={styles.stack}>
          <Button onClick={() => void onSwitch()}>Switch network</Button>
        </div>
      </Island>
    );
  }

  if (loadError !== null) {
    return (
      <Island className={styles.card}>
        <h2 className={styles.h2}>This circle could not be read</h2>
        <p className={styles.meta}>{loadError}</p>
      </Island>
    );
  }

  if (ctx === null) {
    return (
      <Island className={styles.card}>
        <p className={styles.meta}>Reading the circle…</p>
      </Island>
    );
  }

  const amount = formatUnits(ctx.contributionAmount, CNGN_MAINNET.decimals);

  return (
    <>
      <Island className={styles.card}>
        <h2 className={styles.h2}>Celo savings circle</h2>
        <p className={styles.mono}>{short(ctx.circleContract)}</p>
        <div className={styles.rows}>
          <div className={styles.row}>
            <span className={styles.k}>Round</span>
            <span className={styles.v}>{ctx.currentRound}</span>
          </div>
          <div className={styles.row}>
            <span className={styles.k}>Contribution</span>
            <span className={styles.v}>{amount} cNGN</span>
          </div>
          <div className={styles.row}>
            <span className={styles.k}>Members</span>
            <span className={styles.v}>{ctx.memberCount}</span>
          </div>
        </div>
      </Island>

      {ctx.mySlot !== null ? (
        <Island className={styles.card}>
          <h2 className={styles.h2}>Your contribution</h2>

          {notLinked ? (
            <p className={styles.meta}>
              This wallet is on chain as a member, but is not yet linked in Iwa. Ask the
              organizer for a wallet-linking invitation before contributing.
            </p>
          ) : ctx.myContributionStatus === "ON_TIME" || ctx.myContributionStatus === "LATE_WITHIN_GRACE" ? (
            <p className={styles.meta}>You are settled for this round.</p>
          ) : ctx.myContributionStatus === "MISSED_DEFAULT" ? (
            <p className={styles.meta}>This round&rsquo;s window has closed without your contribution.</p>
          ) : (
            <>
              {contributeError && <div className={styles.notice}>{contributeError}</div>}
              {contributeResult && <div className={styles.success}>{contributeResult}</div>}

              {prepared === null ? (
                <div className={styles.stack}>
                  <Button onClick={() => void onPrepare()} disabled={contributeBusy !== null}>
                    Prepare contribution
                  </Button>
                </div>
              ) : (
                <>
                  <p className={styles.meta}>
                    {prepared.requiresOnChainApproval
                      ? `This will approve and send ${amount} cNGN to this circle.`
                      : `This will send ${amount} cNGN to this circle.`}
                  </p>
                  <div className={styles.stack}>
                    <Button onClick={() => void onContribute()} disabled={contributeBusy !== null}>
                      Confirm contribution
                    </Button>
                  </div>
                </>
              )}
              {contributeBusy && <p className={styles.busy}>{contributeBusy}…</p>}
            </>
          )}
        </Island>
      ) : null}

      {ctx.isScheduledRecipient && ctx.payoutStatus === "SCHEDULED" ? (
        <Island className={styles.card}>
          <h2 className={styles.h2}>Collect this round&rsquo;s pot</h2>
          <p className={styles.meta}>
            It is your turn to collect. Anyone can trigger the transfer, but the funds always go
            to you.
          </p>
          {collectError && <div className={styles.notice}>{collectError}</div>}
          {collectResult && <div className={styles.success}>{collectResult}</div>}
          <div className={styles.stack}>
            <Button onClick={() => void onCollect()} disabled={collectBusy}>
              Collect pot
            </Button>
          </div>
          {collectBusy && <p className={styles.busy}>Waiting for confirmation…</p>}
        </Island>
      ) : null}

      <CeloRecoverySection
        recoverableRounds={ctx.recoverableRounds}
        amount={amount}
        busyRound={recoverBusy}
        error={recoverError}
        result={recoverResult}
        onRecover={(round) => void onRecover(round)}
      />

      {ctx.isOrganizer ? (
        <Island className={styles.card}>
          <h2 className={styles.h2}>Member wallets</h2>
          <p className={styles.meta}>
            Invite each member to link the wallet Iwa should recognise for their place.
          </p>
          <div className={styles.rows}>
            {ctx.members.map((address, slot) => {
              const memberRef = celoDomainCircle(ctx).payoutOrder[slot];
              const row = rowFor(slot);
              return (
                <div className={styles.row} key={address}>
                  <span className={styles.v}>{short(address)}</span>
                  <span className={styles.stack}>
                    <span className={styles.k}>
                      {row.status === "unknown" ? "Status unknown" : row.status}
                    </span>
                    {row.inviteLink === null ? (
                      <Button
                        variant="ghost"
                        onClick={() => void onCheckStatus(slot, memberRef)}
                        disabled={row.checking}
                      >
                        {row.checking ? "Checking…" : "Check status"}
                      </Button>
                    ) : null}
                    {row.status !== "bound" && row.inviteLink === null ? (
                      <Button
                        variant="ghost"
                        onClick={() => void onInvite(slot, memberRef)}
                        disabled={row.inviting}
                      >
                        {row.inviting ? "Creating invite…" : "Create invite"}
                      </Button>
                    ) : null}
                    {row.inviteLink !== null ? (
                      <span className={styles.mono}>{row.inviteLink}</span>
                    ) : null}
                    {row.error !== null ? <span className={styles.meta}>{row.error}</span> : null}
                  </span>
                </div>
              );
            })}
          </div>
        </Island>
      ) : null}
    </>
  );
}

/**
 * The recovery card, pulled out as its own component so its display logic
 * (which rounds, what amount, when the action is gone) can be tested
 * directly with a plain array of rounds, without needing a wallet or a
 * chain read to render. `recoverableRounds` is expected to come only from
 * circleModel's on-chain-derived list — this component never invents a
 * round, an amount, or a recipient of its own.
 */
export function CeloRecoverySection({
  recoverableRounds,
  amount,
  busyRound,
  error,
  result,
  onRecover,
}: {
  recoverableRounds: number[];
  amount: string;
  busyRound: number | null;
  error: string | null;
  result: string | null;
  onRecover: (round: number) => void;
}) {
  // A confirmed recovery removes its own round from recoverableRounds on the
  // very reload that reports it: without this, the success message would
  // vanish in the same instant it would otherwise appear. The card stays
  // long enough to show that one message, then disappears on the next
  // navigation/reload once there is nothing left to say.
  if (recoverableRounds.length === 0 && error === null && result === null) return null;
  return (
    <Island className={styles.card}>
      <h2 className={styles.h2}>Contribution recovery</h2>
      {error && <div className={styles.notice}>{error}</div>}
      {result && <div className={styles.success}>{result}</div>}
      <div className={styles.rows}>
        {recoverableRounds.map((round) => (
          <div className={styles.row} key={round}>
            <span className={styles.meta}>
              Round {round}: your contribution of {amount} cNGN from this round can be returned.
            </span>
            <Button onClick={() => onRecover(round)} disabled={busyRound !== null}>
              {busyRound === round ? "Recovering…" : "Recover contribution"}
            </Button>
          </div>
        ))}
      </div>
    </Island>
  );
}
