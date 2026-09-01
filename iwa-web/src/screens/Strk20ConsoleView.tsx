// Strk20ConsoleView — operator console for the STRK20 mainnet run.
//
// Purpose: secure the three required pool-touching mainnet transactions
// (shield, contribution A, contribution B) through a privacy-enabled wallet.
// Payout is deliberately not here.
//
// Safety rules this screen enforces:
//   - Nothing is ever sent automatically. Every send is a distinct button
//     click, and the exact action and its cost are shown before it.
//   - Fail closed. Wrong network, missing STRK20 support, a drifted class
//     hash, a non-Pending obligation, a consumed nonce, or stale helper
//     surplus all block the button rather than being warned past.
//   - Member auth keys live in React state for the session only. They are
//     never written to localStorage or sessionStorage, never logged, never
//     sent anywhere, and are cleared on disconnect. A refresh loses them,
//     which is the intended behaviour.
//   - The wallet holds the viewing key and does the proving. This app never
//     sees private state.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Store } from "@starknet-io/get-starknet-discovery";
import { walletV6, type RpcProvider } from "starknet";

import styles from "./Strk20ConsoleView.module.css";
import { Button } from "../components/Button";
import { STARKNET_MAINNET, sameAddress, voyagerTxUrl } from "../chains/starknetProduction";
import {
  connectWallet,
  createWalletStore,
  detectWallets,
  supportsStrk20,
  WalletUnsupportedError,
  type ConnectedWallet,
  type DetectedWallet,
} from "../chains/strk20/walletConnect";
import {
  buildContributionActions,
  buildShieldActions,
  type IwaSignature,
} from "../chains/strk20/strk20Actions";
import {
  describeUnknownError,
  dryRun,
  shieldedBalances,
  submit,
} from "../chains/strk20/iwaStrk20Client";
import {
  deriveMemberIdentity,
  feltHex,
  contributionNonce,
  contributionSettlementHash,
  signChecked,
  type MemberIdentity,
} from "../chains/strk20/iwaSigning";
import {
  USDC_DECIMALS,
  STRK_DECIMALS,
  computeFunding,
  computeShortfalls,
  formatUnits,
  type FundingPlan,
  type Shortfall,
} from "../chains/strk20/funding";
import { contributionBlockers, hasContributed } from "../chains/strk20/contributionGate";
import {
  classHashMatches,
  currentBlock,
  erc20Allowance,
  erc20Balance,
  findContributionTransaction,
  getCircle,
  getContributionObligation,
  getPayoutOrder,
  getRoundLiability,
  helperBlocked,
  helperSurplus,
  isContributionNonceConsumed,
  isMember,
  isRegistered,
  makeProvider,
  poolFeeAmount,
  verifyShieldTransaction,
  verifyTransaction,
  type ShieldVerification,
  type CircleView,
  type ObligationView,
  type TxVerification,
} from "../chains/strk20/publicReads";

const RPC_URL = "https://api.cartridge.gg/x/starknet/mainnet";

const MEMBER_LIMIT = 2;
const CONTRIBUTION_AMOUNT = 1_000_000n; // 1.00 USDC, six decimals
const NOTE_MATURITY_BLOCKS = 10;

type Status = "ok" | "wait" | "bad";

function Badge({ status, children }: { status: Status; children: React.ReactNode }) {
  const cls =
    status === "ok" ? styles.badgeOk : status === "bad" ? styles.badgeBad : styles.badgeWait;
  return <span className={`${styles.badge} ${cls}`}>{children}</span>;
}

function Step({
  n,
  name,
  status,
  children,
}: {
  n: string;
  name: string;
  status: Status;
  children: React.ReactNode;
}) {
  const shell =
    status === "ok" ? styles.stepDone : status === "bad" ? styles.stepBlocked : "";
  return (
    <section className={`${styles.step} ${shell}`}>
      <header className={styles.stepHead}>
        <span className={styles.stepName}>
          {n}. {name}
        </span>
        <Badge status={status}>{status === "ok" ? "ready" : status === "bad" ? "blocked" : "pending"}</Badge>
      </header>
      {children}
    </section>
  );
}

function Row({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className={styles.row}>
      <span>{label}</span>
      <span className={`${styles.mono} ${bad ? styles.warn : ""}`}>{value}</span>
    </div>
  );
}

interface RecordedTx {
  hash: string;
  label: string;
  verification?: TxVerification;
}

export function Strk20ConsoleView() {
  const storeRef = useRef<Store | null>(null);
  const [wallets, setWallets] = useState<DetectedWallet[]>([]);
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const provider = useMemo<RpcProvider>(() => makeProvider(RPC_URL), []);

  // Deployment integrity, read live rather than assumed from the constants.
  const [deploymentOk, setDeploymentOk] = useState<boolean | null>(null);
  const [blockedDepositor, setBlockedDepositor] = useState<boolean | null>(null);

  // Funding
  const [feeAmount, setFeeAmount] = useState<bigint | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<bigint | null>(null);
  const [strkBalance, setStrkBalance] = useState<bigint | null>(null);
  const [usdcAllowance, setUsdcAllowance] = useState<bigint | null>(null);
  const [strkAllowance, setStrkAllowance] = useState<bigint | null>(null);

  // Member secrets — session memory only. Never persisted, never logged.
  const [secretA, setSecretA] = useState("");
  const [keyA, setKeyA] = useState("");
  const [secretB, setSecretB] = useState("");
  const [keyB, setKeyB] = useState("");
  const [members, setMembers] = useState<MemberIdentity[] | null>(null);

  // Circle
  const [circleIdInput, setCircleIdInput] = useState("");
  const [circle, setCircle] = useState<CircleView | null>(null);
  const [obligations, setObligations] = useState<Record<string, ObligationView> | null>(null);
  const [helperSurplusUsdc, setHelperSurplusUsdc] = useState<bigint | null>(null);

  // STRK20 pool registration. An unregistered account cannot build or submit
  // any private action, so this is read before anything else is attempted.
  const [registered, setRegistered] = useState<boolean | null>(null);

  // Shielded balance is read ONLY on explicit user action: strk20Balances
  // prompts the wallet for consent to reveal private data, so it must never
  // fire on load, on connect, or as part of a background refresh.
  const [shieldedUsdc, setShieldedUsdc] = useState<bigint | null>(null);

  // The shield may already have been done inside the wallet. Its hash is
  // imported and verified rather than re-sent.
  const [shieldHashInput, setShieldHashInput] = useState("");
  const [importedShield, setImportedShield] = useState<ShieldVerification | null>(null);

  // Run
  const [shieldBlock, setShieldBlock] = useState<number | null>(null);
  const [nowBlock, setNowBlock] = useState<number | null>(null);
  const [txs, setTxs] = useState<RecordedTx[]>([]);
  const [preview, setPreview] = useState<{ key: string; text: string } | null>(null);
  // Timestamped, secret-free trace of what the console actually did. This is
  // the difference between "nothing happened" and a diagnosable failure.
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const trace = useCallback((message: string) => {
    const stamp = new Date().toISOString().slice(11, 19);
    setDiagnostics((d) => [...d.slice(-40), stamp + "  " + message]);
  }, []);

  const shieldCompleted =
    shieldBlock !== null || importedShield?.isUsdcShield === true;

  // Maturity is measured from whichever shield actually happened — one sent
  // here, or one imported from the wallet.
  const effectiveShieldBlock = shieldBlock ?? importedShield?.blockNumber ?? null;

  const plan: FundingPlan | null = useMemo(
    () =>
      feeAmount === null
        ? null
        : computeFunding({
            feeAmount,
            memberLimit: MEMBER_LIMIT,
            contributionAmount: CONTRIBUTION_AMOUNT,
            shieldCompleted,
          }),
    [feeAmount, shieldCompleted],
  );

  const shortfalls: Shortfall[] = useMemo(() => {
    if (
      plan === null ||
      usdcBalance === null ||
      strkBalance === null ||
      usdcAllowance === null ||
      strkAllowance === null
    ) {
      return [];
    }
    return computeShortfalls({
      plan,
      usdcBalance,
      strkBalance,
      usdcAllowance,
      strkAllowance,
      shieldedUsdc,
    });
  }, [plan, usdcBalance, strkBalance, usdcAllowance, strkAllowance, shieldedUsdc]);

  const run = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      setError(null);
      setBusy(label);
      setStartedAt(Date.now());
      trace("START  " + label);
      try {
        await fn();
        trace("OK     " + label);
      } catch (e) {
        // Every shape of rejection is rendered, including JSON-RPC error
        // objects that would otherwise stringify to "[object Object]".
        const message = describeUnknownError(e);
        setError(label + " failed: " + message);
        trace("FAIL   " + label + ": " + message);
      } finally {
        setBusy(null);
        setStartedAt(null);
      }
    },
    [trace],
  );

  // A wallet approval popup that never opens leaves the promise pending
  // forever. Showing elapsed time makes that visible instead of silent.
  useEffect(() => {
    if (startedAt === null) {
      setElapsed(0);
      return;
    }
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  /**
   * Re-confirms, right before a wallet call, that the connection is still
   * live and still speaks STRK20. A wallet locked, switched, or downgraded
   * after connect otherwise fails deep inside the SDK with an opaque message.
   */
  const assertLiveCapability = useCallback(
    async (connected: ConnectedWallet) => {
      const detected = wallets.find((w) => w.name === connected.walletName);
      if (!detected) {
        throw new Error(
          `${connected.walletName} is no longer detected in this page — reconnect the wallet`,
        );
      }
      const versions = await walletV6.supportedWalletApi(
        detected.wallet as Parameters<typeof walletV6.supportedWalletApi>[0],
      );
      trace(`wallet API versions: ${versions.join(", ") || "(none)"}`);
      if (!supportsStrk20(versions)) {
        throw new Error(
          `${connected.walletName} no longer advertises the STRK20 Wallet API — reconnect it`,
        );
      }
      const chainId = await walletV6.requestChainId(
        detected.wallet as Parameters<typeof walletV6.requestChainId>[0],
      );
      trace(`wallet chain id: ${chainId}`);
      if (!sameAddress(chainId, STARKNET_MAINNET.chainId)) {
        throw new Error(`wallet is on ${chainId}, not SN_MAIN — switch networks`);
      }
      // The pool itself is the authority on registration, not the wallet.
      if (!(await isRegistered(provider, connected.address))) {
        throw new Error(
          "this account has not registered its viewing key with the STRK20 pool. No dapp can " +
            "register for you — the Wallet API has no registration action. Complete the private-" +
            "balance setup inside your wallet, then press Refresh here.",
        );
      }
    },
    [wallets, trace, provider],
  );

  // Nothing may fail silently. Anything that escapes a handler — a rejection
  // from a fire-and-forget path, or a wallet extension throwing out of band —
  // lands in the visible log and the error banner.
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => {
      const message = describeUnknownError(e.reason);
      setError(`unhandled rejection: ${message}`);
      trace(`UNHANDLED  ${message}`);
    };
    const onError = (e: ErrorEvent) => {
      trace(`WINDOW ERROR  ${e.message}`);
    };
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("error", onError);
    return () => {
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("error", onError);
    };
  }, [trace]);

  // --- discovery ---

  useEffect(() => {
    const store = createWalletStore();
    storeRef.current = store;
    const refresh = () => {
      void detectWallets(store).then(setWallets);
    };
    refresh();
    return store.subscribe(refresh);
  }, []);

  // --- deployment integrity, independent of any wallet ---

  useEffect(() => {
    void (async () => {
      try {
        const checks = await Promise.all([
          classHashMatches(provider, STARKNET_MAINNET.iwaCircle, STARKNET_MAINNET.iwaCircleClass),
          classHashMatches(provider, STARKNET_MAINNET.iwaHelper, STARKNET_MAINNET.iwaHelperClass),
          classHashMatches(
            provider,
            STARKNET_MAINNET.privacyPool,
            STARKNET_MAINNET.privacyPoolClass,
          ),
        ]);
        setDeploymentOk(checks.every(Boolean));
        setBlockedDepositor(await helperBlocked(provider));
        setFeeAmount(await poolFeeAmount(provider));
      } catch (e) {
        setError(`chain reads failed: ${(e as Error).message}`);
        setDeploymentOk(false);
      }
    })();
  }, [provider]);

  const refreshFunding = useCallback(
    async (address: string) => {
      const [ub, sb, ua, sa, blk] = await Promise.all([
        erc20Balance(provider, STARKNET_MAINNET.usdcToken, address),
        erc20Balance(provider, STARKNET_MAINNET.strkToken, address),
        erc20Allowance(provider, STARKNET_MAINNET.usdcToken, address, STARKNET_MAINNET.privacyPool),
        erc20Allowance(provider, STARKNET_MAINNET.strkToken, address, STARKNET_MAINNET.privacyPool),
        currentBlock(provider),
      ]);
      setUsdcBalance(ub);
      setStrkBalance(sb);
      setUsdcAllowance(ua);
      setStrkAllowance(sa);
      setNowBlock(blk);
      setHelperSurplusUsdc(await helperSurplus(provider, STARKNET_MAINNET.usdcToken));
      const reg = await isRegistered(provider, address);
      setRegistered(reg);
      trace("pool registration for " + address + ": " + (reg ? "registered" : "NOT registered"));
    },
    [provider, trace],
  );

  const onConnect = useCallback(
    (detected: DetectedWallet) =>
      run("connect", async () => {
        try {
          const connected = await connectWallet(detected, RPC_URL);
          setWallet(connected);
          await refreshFunding(connected.address);
        } catch (e) {
          if (e instanceof WalletUnsupportedError) throw new Error(e.message);
          throw e;
        }
      }),
    [run, refreshFunding],
  );

  /** Drops the session: wallet handle and every secret held in memory. */
  const onDisconnect = useCallback(() => {
    setWallet(null);
    setMembers(null);
    setSecretA("");
    setKeyA("");
    setSecretB("");
    setKeyB("");
    setCircle(null);
    setObligations(null);
    setPreview(null);
    setRegistered(null);
    setShieldedUsdc(null);
  }, []);

  // --- member identities ---

  const onDeriveMembers = useCallback(
    () =>
      run("derive", async () => {
        const parse = (v: string, what: string): bigint => {
          const t = v.trim();
          if (!/^0x[0-9a-fA-F]{1,64}$/.test(t)) throw new Error(`${what} is not a 0x hex felt`);
          const n = BigInt(t);
          if (n === 0n) throw new Error(`${what} must not be zero`);
          return n;
        };
        const a = deriveMemberIdentity("A", parse(secretA, "member A secret"), parse(keyA, "member A key"));
        const b = deriveMemberIdentity("B", parse(secretB, "member B secret"), parse(keyB, "member B key"));
        if (a.memberRef === b.memberRef) throw new Error("members A and B collide");
        setMembers([a, b]);
      }),
    [run, secretA, keyA, secretB, keyB],
  );

  // --- transparent IWA calls ---

  const sendTransparent = useCallback(
    (label: string, calls: { contractAddress: string; entrypoint: string; calldata: string[] }[]) =>
      run(label, async () => {
        if (!wallet) throw new Error("connect a wallet first");
        const res = await wallet.account.execute(calls);
        setTxs((t) => [...t, { hash: res.transaction_hash, label }]);
        await refreshFunding(wallet.address);
      }),
    [run, wallet, refreshFunding],
  );

  const onApproveUsdc = useCallback(() => {
    if (!plan) return;
    const lo = plan.usdcApprovalRequired & ((1n << 128n) - 1n);
    const hi = plan.usdcApprovalRequired >> 128n;
    return sendTransparent("approve USDC to pool", [
      {
        contractAddress: STARKNET_MAINNET.usdcToken,
        entrypoint: "approve",
        calldata: [STARKNET_MAINNET.privacyPool, feltHex(lo), feltHex(hi)],
      },
    ]);
  }, [plan, sendTransparent]);

  const onApproveStrk = useCallback(() => {
    if (!plan) return;
    const lo = plan.strkApprovalRequired & ((1n << 128n) - 1n);
    const hi = plan.strkApprovalRequired >> 128n;
    return sendTransparent("approve STRK to pool", [
      {
        contractAddress: STARKNET_MAINNET.strkToken,
        entrypoint: "approve",
        calldata: [STARKNET_MAINNET.privacyPool, feltHex(lo), feltHex(hi)],
      },
    ]);
  }, [plan, sendTransparent]);

  const onCreateCircle = useCallback(() => {
    if (!members) return;
    return sendTransparent("create_circle", [
      {
        contractAddress: STARKNET_MAINNET.iwaCircle,
        entrypoint: "create_circle",
        calldata: [
          STARKNET_MAINNET.usdcToken,
          feltHex(CONTRIBUTION_AMOUNT),
          "604800",
          "86400",
          String(MEMBER_LIMIT),
          String(MEMBER_LIMIT),
          ...members.map((m) => feltHex(m.memberRef)),
        ],
      },
    ]);
  }, [members, sendTransparent]);

  const onJoin = useCallback(
    (m: MemberIdentity) => {
      const id = Number(circleIdInput);
      if (!Number.isInteger(id) || id <= 0) {
        setError("enter the circle id returned by create_circle first");
        return;
      }
      return sendTransparent(`join_circle member ${m.label}`, [
        {
          contractAddress: STARKNET_MAINNET.iwaCircle,
          entrypoint: "join_circle",
          calldata: [String(id), feltHex(m.inviteSecret), feltHex(m.authPublicKeyX)],
        },
      ]);
    },
    [circleIdInput, sendTransparent],
  );

  const onLoadCircle = useCallback(
    () =>
      run("load circle", async () => {
        const id = Number(circleIdInput);
        if (!Number.isInteger(id) || id <= 0) throw new Error("enter a circle id");
        const c = await getCircle(provider, id);
        setCircle(c);

        if (members) {
          const order = await getPayoutOrder(provider, id);
          const want = members.map((m) => feltHex(m.memberRef));
          const matches =
            order.length === want.length && order.every((r, i) => sameAddress(r, want[i]));
          if (!matches) {
            throw new Error("this circle's payout order does not match the loaded members");
          }
          const next: Record<string, ObligationView> = {};
          for (const m of members) {
            if (!(await isMember(provider, id, feltHex(m.memberRef)))) continue;
            if (c.status !== "Active") continue;
            next[m.label] = await getContributionObligation(
              provider,
              id,
              c.currentRound,
              feltHex(m.memberRef),
            );
          }
          setObligations(next);
        }
        setHelperSurplusUsdc(await helperSurplus(provider, STARKNET_MAINNET.usdcToken));
      }),
    [run, circleIdInput, provider, members],
  );

  // --- pool transactions ---

  /**
   * Reads the shielded balance. Explicit user action only: the wallet prompts
   * for consent to reveal private data, so this is never called on load,
   * on connect, or from a background refresh.
   */
  const onReadShieldedBalance = useCallback(
    () =>
      run("read shielded balance (wallet consent)", async () => {
        if (!wallet) throw new Error("connect a wallet first");
        trace("requesting shielded balances — the wallet will ask for consent");
        const entries = await shieldedBalances(wallet, [STARKNET_MAINNET.usdcToken]);
        const usdc = entries.find((e) => sameAddress(String(e.token), STARKNET_MAINNET.usdcToken));
        const amount = usdc ? BigInt(usdc.balance) : 0n;
        setShieldedUsdc(amount);
        trace("shielded USDC: " + formatUnits(amount, USDC_DECIMALS));
      }),
    [run, wallet, trace],
  );

  /**
   * Imports a shield already completed inside the wallet and proves it really
   * shielded USDC. A registration transaction also touches the pool, so
   * touching the pool alone is not accepted.
   */
  const onImportShield = useCallback(
    () =>
      run("import Ready shield transaction", async () => {
        const hash = shieldHashInput.trim();
        if (!/^0x[0-9a-fA-F]{1,64}$/.test(hash)) throw new Error("enter a 0x transaction hash");
        trace("verifying imported shield " + hash);
        const v = await verifyShieldTransaction(provider, hash);
        setImportedShield(v);
        if (!v.isUsdcShield) {
          throw new Error("not accepted as the shield: " + v.reasons.join("; "));
        }
        setTxs((t) =>
          t.some((x) => sameAddress(x.hash, hash))
            ? t
            : [...t, { hash, label: "shield USDC via wallet (POOL)", verification: v }],
        );
        trace("imported shield verified: USDC moved into the pool");
      }),
    [run, shieldHashInput, provider, trace],
  );

  const onShield = useCallback(
    (dry: boolean) =>
      run(dry ? "dry-build shield" : "shield", async () => {
        if (!wallet) throw new Error("connect a wallet first");
        if (!plan) throw new Error("pool fee has not been read yet — reload the page");
        await assertLiveCapability(wallet);

        const actions = buildShieldActions({
          token: STARKNET_MAINNET.usdcToken,
          amount: plan.usdcRequired.toString(),
        });
        trace(`shield actions: ${JSON.stringify(actions)}`);

        if (dry) {
          const built = await dryRun(wallet, actions, trace);
          setPreview({
            key: "shield",
            text: [
              "DRY-BUILD OK",
              `action: SHIELD ${formatUnits(plan.usdcRequired, USDC_DECIMALS)} USDC into the pool`,
              `pool fee: ${formatUnits(plan.feeAmount, STRK_DECIMALS)} STRK (pulled from your STRK allowance, not gas)`,
              `entry point: ${String(built.call.entry_point ?? "?")}`,
              `calldata felts: ${built.call.calldata?.length ?? 0}`,
              "proof: simulated (empty, not submittable)",
              "",
              JSON.stringify(actions, null, 2),
            ].join("\n"),
          });
          return;
        }

        const { transactionHash } = await submit(wallet, actions, trace);
        setTxs((t) => [...t, { hash: transactionHash, label: "shield USDC (POOL)" }]);
        setShieldBlock(await currentBlock(provider));
        await refreshFunding(wallet.address);
      }),
    [run, wallet, plan, provider, refreshFunding, trace, assertLiveCapability],
  );

  const contributionFor = useCallback(
    async (m: MemberIdentity): Promise<{ actions: ReturnType<typeof buildContributionActions>; hash: bigint; sig: IwaSignature }> => {
      const id = Number(circleIdInput);
      if (!circle) throw new Error("load the circle first");
      if (circle.status !== "Active") throw new Error(`circle is ${circle.status}, not Active`);

      // Same source of truth as the app seam: one nonce per round, shared by
      // the precheck, the signed hash and the calldata.
      const nonce = contributionNonce(circle.currentRound);

      const ob = await getContributionObligation(
        provider,
        id,
        circle.currentRound,
        feltHex(m.memberRef),
      );
      if (ob.status !== "Pending") {
        throw new Error(`member ${m.label} obligation is ${ob.status}, not Pending`);
      }
      if (
        await isContributionNonceConsumed(provider, id, feltHex(m.memberRef), nonce)
      ) {
        throw new Error(`contribution nonce ${nonce} already consumed for ${m.label}`);
      }
      const surplus = await helperSurplus(provider, STARKNET_MAINNET.usdcToken);
      if (surplus !== 0n) {
        throw new Error(
          `helper holds ${formatUnits(surplus, USDC_DECIMALS)} USDC of unaccounted surplus — ` +
            "call normalize_surplus(USDC) before settling",
        );
      }

      const messageHash = contributionSettlementHash({
        circleId: id,
        round: circle.currentRound,
        memberRef: m.memberRef,
        helper: BigInt(STARKNET_MAINNET.iwaHelper),
        pool: BigInt(STARKNET_MAINNET.privacyPool),
        token: BigInt(STARKNET_MAINNET.usdcToken),
        amount: ob.requiredAmount,
        nonce,
      });
      const raw = signChecked(m, messageHash, "contribution settlement");
      const sig: IwaSignature = { r: feltHex(raw.r), s: feltHex(raw.s) };

      return {
        actions: buildContributionActions({
          circleId: id,
          round: circle.currentRound,
          memberRef: feltHex(m.memberRef),
          token: STARKNET_MAINNET.usdcToken,
          amount: ob.requiredAmount.toString(),
          nonce,
          signature: sig,
        }),
        hash: messageHash,
        sig,
      };
    },
    [circleIdInput, circle, provider],
  );

  const onContribute = useCallback(
    (m: MemberIdentity, dry: boolean) =>
      run(dry ? `dry-build contribution ${m.label}` : `contribution ${m.label}`, async () => {
        if (!wallet) throw new Error("connect a wallet first");
        if (!plan) throw new Error("pool fee has not been read yet — reload the page");
        await assertLiveCapability(wallet);

        const { actions, hash } = await contributionFor(m);
        trace(`contribution ${m.label} actions: ${JSON.stringify(actions)}`);

        if (dry) {
          const built = await dryRun(wallet, actions, trace);
          setPreview({
            key: `contribution-${m.label}`,
            text: [
              "DRY-BUILD OK",
              `action: CONTRIBUTION ${m.label}`,
              `amount: ${formatUnits(CONTRIBUTION_AMOUNT, USDC_DECIMALS)} USDC withdrawn to the helper`,
              `pool fee: ${formatUnits(plan.feeAmount, STRK_DECIMALS)} STRK`,
              `settlement message hash: ${feltHex(hash)}`,
              `entry point: ${String(built.call.entry_point ?? "?")}`,
              `calldata felts: ${built.call.calldata?.length ?? 0}`,
              "proof: simulated (empty, not submittable)",
              "",
              JSON.stringify(actions, null, 2),
            ].join("\n"),
          });
          return;
        }

        const { transactionHash } = await submit(wallet, actions, trace);
        setTxs((t) => [
          ...t,
          { hash: transactionHash, label: `contribution ${m.label} (POOL)` },
        ]);
        await refreshFunding(wallet.address);
      }),
    [run, wallet, plan, contributionFor, refreshFunding, trace, assertLiveCapability],
  );

  /**
   * Recovers a contribution whose wallet call timed out.
   *
   * A submission can time out after the network already accepted it. The chain
   * is the record, not the client: if the circle emitted
   * ContributionStateUpdated for this member and round, the settling
   * transaction exists and its hash is recoverable. Read-only — it never
   * resubmits, and it can only report a hash the contract actually emitted.
   */
  const onRecoverContribution = useCallback(
    (m: MemberIdentity) =>
      run(`recover contribution ${m.label}`, async () => {
        const id = Number(circleIdInput);
        if (!circle) throw new Error("load the circle first");
        const fromBlock = effectiveShieldBlock;
        if (fromBlock === null) {
          throw new Error("import the shield transaction first so the search has a start block");
        }
        trace(`searching IwaCircle events for member ${m.label} from block ${fromBlock}`);
        const found = await findContributionTransaction(provider, {
          circleId: id,
          round: circle.currentRound,
          memberRef: feltHex(m.memberRef),
          fromBlock,
        });
        if (found === null) {
          throw new Error(
            `no ContributionStateUpdated event for member ${m.label} in circle ${id} round ` +
              `${circle.currentRound} — the contribution did not settle`,
          );
        }
        trace(`recovered ${found.hash} at block ${found.blockNumber} (${found.status})`);
        const verification = await verifyTransaction(provider, found.hash);
        setTxs((t) =>
          t.some((x) => sameAddress(x.hash, found.hash))
            ? t
            : [
                ...t,
                {
                  hash: found.hash,
                  label: `contribution ${m.label} (POOL, recovered)`,
                  verification,
                },
              ],
        );
      }),
    [run, circleIdInput, circle, effectiveShieldBlock, provider, trace],
  );

  const onVerifyAll = useCallback(
    () =>
      run("verify", async () => {
        const verified = await Promise.all(
          txs.map(async (t) => ({ ...t, verification: await verifyTransaction(provider, t.hash) })),
        );
        setTxs(verified);
        const id = Number(circleIdInput);
        if (circle && Number.isInteger(id) && id > 0) {
          const liability = await getRoundLiability(provider, id, circle.currentRound);
          const next: Record<string, ObligationView> = {};
          for (const m of members ?? []) {
            next[m.label] = await getContributionObligation(
              provider,
              id,
              circle.currentRound,
              feltHex(m.memberRef),
            );
          }
          setObligations(next);
          setPreview({
            key: "verify",
            text: [
              `ROUND ${circle.currentRound} LIABILITY`,
              `settled in:  ${formatUnits(liability.settledInflows, USDC_DECIMALS)} USDC`,
              `settled out: ${formatUnits(liability.settledOutflows, USDC_DECIMALS)} USDC`,
              `outstanding: ${formatUnits(liability.outstanding, USDC_DECIMALS)} USDC`,
            ].join("\n"),
          });
        }
      }),
    [run, txs, provider, circle, circleIdInput, members],
  );

  const confirmedPoolHashes = txs.filter(
    (t) => t.verification?.succeeded && t.verification.touchesPool,
  );

  const maturityRemaining =
    effectiveShieldBlock !== null && nowBlock !== null
      ? Math.max(0, effectiveShieldBlock + NOTE_MATURITY_BLOCKS - nowBlock)
      : null;

  /**
   * Blockers for ONE member, computed by the shared pure gate. Per member is
   * the point: once A settles, A is OnTime forever, and requiring every
   * obligation to be Pending would make B permanently unreachable.
   */
  const blockersFor = useCallback(
    (memberLabel: string): string[] =>
      contributionBlockers({
        memberLabel,
        walletConnected: wallet !== null,
        registered,
        shieldedUsdc,
        shieldedUsdcRequired: plan?.shieldedUsdcRequired ?? 0n,
        shieldCompleted,
        circleStatus: circle?.status ?? null,
        obligations,
        helperSurplus: helperSurplusUsdc,
        strkAllowance: strkAllowance ?? 0n,
        strkAllowanceRequired: plan?.strkApprovalRequired ?? 0n,
        maturityRemaining,
      }),
    [
      wallet,
      registered,
      shieldedUsdc,
      plan,
      shieldCompleted,
      circle,
      obligations,
      helperSurplusUsdc,
      strkAllowance,
      maturityRemaining,
    ],
  );

  // --- render ---

  const configStatus: Status = deploymentOk === null ? "wait" : deploymentOk && blockedDepositor === false ? "ok" : "bad";
  const walletStatus: Status = wallet ? "ok" : "wait";
  const fundingStatus: Status =
    plan === null || usdcBalance === null ? "wait" : shortfalls.length === 0 ? "ok" : "bad";
  const membersStatus: Status = members ? "ok" : "wait";
  const circleStatus: Status =
    circle === null ? "wait" : circle.status === "Active" ? "ok" : "bad";

  return (
    <div className={styles.console}>
      <h1 className={styles.title}>IWA · STRK20 mainnet execution console</h1>
      <p className={styles.subtitle}>
        Shield + two private contributions. Read-only until you click a send button. Payout is not
        in this run.
      </p>

      {error && <div className={styles.notice}>{error}</div>}
      {busy && (
        <div className={styles.row}>
          <span>working: {busy}…</span>
          <span className={styles.mono}>
            {elapsed}s{elapsed > 20 ? " — check your wallet for an open approval prompt" : ""}
          </span>
        </div>
      )}

      <Step n="1" name="Deployment integrity (read-only)" status={configStatus}>
        <Row label="IwaCircle" value={STARKNET_MAINNET.iwaCircle} />
        <Row label="IwaStrk20Helper" value={STARKNET_MAINNET.iwaHelper} />
        <Row label="STRK20 pool" value={STARKNET_MAINNET.privacyPool} />
        <Row
          label="class hashes match"
          value={deploymentOk === null ? "checking…" : deploymentOk ? "yes" : "NO"}
          bad={deploymentOk === false}
        />
        <Row
          label="helper blocked as depositor"
          value={blockedDepositor === null ? "checking…" : blockedDepositor ? "YES" : "no"}
          bad={blockedDepositor === true}
        />
        <Row
          label="live pool fee"
          value={feeAmount === null ? "…" : `${formatUnits(feeAmount, STRK_DECIMALS)} STRK per pool tx`}
        />
      </Step>

      <Step n="2" name="Connect a privacy-enabled wallet (Ready)" status={walletStatus}>
        {wallet ? (
          <>
            <Row label="wallet" value={wallet.walletName} />
            <Row label="address" value={wallet.address} />
            <Row label="chain" value={`${wallet.chainId} (SN_MAIN)`} />
            <Row
              label="STRK20 pool registration"
              value={
                registered === null
                  ? "checking…"
                  : registered
                    ? "registered"
                    : "NOT REGISTERED — no private action can be built"
              }
              bad={registered === false}
            />
            {registered === false && (
              <div className={styles.notice}>
                A dapp cannot register you: the Wallet API exposes only deposit, withdraw,
                transfer and invoke — there is no registration action, and only the wallet holds
                the viewing key it must publish. Open {wallet.walletName} and complete its own
                private-balance setup (shield once from inside the wallet), then press Refresh in
                step 3. The pool view get_public_key for this address must stop returning 0x0.
              </div>
            )}
            <div className={styles.actions}>
              <Button variant="ghost" onClick={onDisconnect}>
                Disconnect and clear secrets
              </Button>
            </div>
          </>
        ) : (
          <>
            {wallets.length === 0 && <div>No Starknet wallet detected. Install Ready and reload.</div>}
            <div className={styles.actions}>
              {wallets.map((w) => (
                <Button
                  key={w.name}
                  onClick={() => void onConnect(w)}
                  disabled={!w.supportsStrk20 || busy !== null}
                  title={w.supportsStrk20 ? "" : "no STRK20 Wallet API support"}
                >
                  {w.name}
                  {w.supportsStrk20 ? "" : " — no STRK20"}
                </Button>
              ))}
            </div>
          </>
        )}
      </Step>

      <Step n="3" name="Funding and pool allowances" status={fundingStatus}>
        {plan === null || usdcBalance === null ? (
          <div>Connect a wallet to read balances.</div>
        ) : (
          <>
            {plan.usdcRequired > 0n ? (
              <Row
                label="transparent USDC (needed to shield)"
                value={`${formatUnits(usdcBalance, USDC_DECIMALS)} / need ${formatUnits(plan.usdcRequired, USDC_DECIMALS)}`}
                bad={usdcBalance < plan.usdcRequired}
              />
            ) : (
              <Row
                label="transparent USDC"
                value={`${formatUnits(usdcBalance, USDC_DECIMALS)} — not required; contributions spend the shielded balance`}
              />
            )}
            <Row
              label="shielded USDC (spent by contributions)"
              value={
                shieldedUsdc === null
                  ? "not read — needs your consent"
                  : `${formatUnits(shieldedUsdc, USDC_DECIMALS)} / need ${formatUnits(plan.shieldedUsdcRequired, USDC_DECIMALS)}`
              }
              bad={shieldedUsdc !== null && shieldedUsdc < plan.shieldedUsdcRequired}
            />
            <Row
              label="STRK balance"
              value={`${formatUnits(strkBalance ?? 0n, STRK_DECIMALS)} / need ${formatUnits(plan.strkRequired, STRK_DECIMALS)}`}
              bad={(strkBalance ?? 0n) < plan.strkRequired}
            />
            {plan.usdcApprovalRequired > 0n && (
              <Row
                label="USDC → pool allowance"
                value={`${formatUnits(usdcAllowance ?? 0n, USDC_DECIMALS)} / need ${formatUnits(plan.usdcApprovalRequired, USDC_DECIMALS)}`}
                bad={(usdcAllowance ?? 0n) < plan.usdcApprovalRequired}
              />
            )}
            <Row
              label="STRK → pool allowance (fee pull, not gas)"
              value={`${formatUnits(strkAllowance ?? 0n, STRK_DECIMALS)} / need ${formatUnits(plan.strkApprovalRequired, STRK_DECIMALS)}`}
              bad={(strkAllowance ?? 0n) < plan.strkApprovalRequired}
            />
            {shortfalls.length > 0 && (
              <div className={styles.notice}>
                Shortfalls: {shortfalls.map((s) => s.label).join(", ")}
              </div>
            )}
            <div className={styles.actions}>
              {plan.usdcApprovalRequired > 0n && (
                <Button onClick={() => void onApproveUsdc()} disabled={!wallet || busy !== null}>
                  Approve {formatUnits(plan.usdcApprovalRequired, USDC_DECIMALS)} USDC → pool
                </Button>
              )}
              <Button
                variant="ghost"
                onClick={() => void onReadShieldedBalance()}
                disabled={!wallet || busy !== null}
                title="prompts your wallet for consent to reveal private balances"
              >
                Read shielded balance (asks consent)
              </Button>
              <Button onClick={() => void onApproveStrk()} disabled={!wallet || busy !== null}>
                Approve {formatUnits(plan.strkApprovalRequired, STRK_DECIMALS)} STRK → pool
              </Button>
              <Button
                variant="ghost"
                onClick={() => wallet && void run("refresh", () => refreshFunding(wallet.address))}
                disabled={!wallet || busy !== null}
              >
                Refresh
              </Button>
            </div>
          </>
        )}
      </Step>

      <Step n="4" name="Member identities (memory only)" status={membersStatus}>
        <p className={styles.subtitle}>
          Held for this session only. Never stored, never logged, cleared on disconnect or refresh.
        </p>
        {members ? (
          members.map((m) => (
            <div key={m.label}>
              <Row label={`member ${m.label} auth key`} value={feltHex(m.authPublicKeyX)} />
              <Row label={`member ${m.label} member_ref`} value={feltHex(m.memberRef)} />
            </div>
          ))
        ) : (
          <>
            {(
              [
                ["Member A invite secret", secretA, setSecretA],
                ["Member A auth private key", keyA, setKeyA],
                ["Member B invite secret", secretB, setSecretB],
                ["Member B auth private key", keyB, setKeyB],
              ] as const
            ).map(([label, value, setter]) => (
              <label key={label} className={styles.field}>
                <span className={styles.fieldLabel}>{label}</span>
                <input
                  className={styles.input}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="0x…"
                  value={value}
                  onChange={(e) => setter(e.target.value)}
                />
              </label>
            ))}
            <div className={styles.actions}>
              <Button onClick={() => void onDeriveMembers()} disabled={busy !== null}>
                Derive member refs
              </Button>
            </div>
          </>
        )}
      </Step>

      <Step n="5" name="Circle: create, join, activate" status={circleStatus}>
        <div className={styles.actions}>
          <Button onClick={() => void onCreateCircle()} disabled={!members || !wallet || busy !== null}>
            create_circle (2 × 1 USDC)
          </Button>
        </div>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Circle id (from the create_circle receipt)</span>
          <input
            className={styles.input}
            inputMode="numeric"
            value={circleIdInput}
            onChange={(e) => setCircleIdInput(e.target.value)}
            placeholder="e.g. 1"
          />
        </label>
        <div className={styles.actions}>
          {(members ?? []).map((m) => (
            <Button
              key={m.label}
              onClick={() => void onJoin(m)}
              disabled={!wallet || busy !== null}
            >
              join_circle {m.label}
            </Button>
          ))}
          <Button variant="ghost" onClick={() => void onLoadCircle()} disabled={busy !== null}>
            Load circle state
          </Button>
        </div>
        {circle && (
          <>
            <Row label="status" value={circle.status} bad={circle.status !== "Active"} />
            <Row label="round" value={String(circle.currentRound)} />
            <Row label="joined" value={`${circle.joinedCount} / ${circle.memberLimit}`} />
            {obligations &&
              Object.entries(obligations).map(([label, o]) => (
                <Row
                  key={label}
                  label={`member ${label} obligation`}
                  value={`${formatUnits(o.requiredAmount, USDC_DECIMALS)} USDC — ${o.status}`}
                  bad={o.status !== "Pending" && o.status !== "OnTime"}
                />
              ))}
            <Row
              label="helper USDC surplus"
              value={helperSurplusUsdc === null ? "…" : formatUnits(helperSurplusUsdc, USDC_DECIMALS)}
              bad={(helperSurplusUsdc ?? 0n) !== 0n}
            />
          </>
        )}
      </Step>

      <Step n="6" name="POOL TX #1 — shield 2 USDC" status={shieldCompleted ? "ok" : "wait"}>
        <p className={styles.subtitle}>
          If you already shielded inside your wallet, import that transaction here — do not shield
          again. Importing verifies the hash really moved USDC into the pool; a registration
          transaction touches the pool too and is not accepted.
        </p>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Wallet shield transaction hash</span>
          <input
            className={styles.input}
            spellCheck={false}
            placeholder="0x…"
            value={shieldHashInput}
            onChange={(e) => setShieldHashInput(e.target.value)}
          />
        </label>
        <div className={styles.actions}>
          <Button onClick={() => void onImportShield()} disabled={busy !== null}>
            Import and verify shield
          </Button>
        </div>
        {importedShield && (
          <>
            <Row
              label="accepted as POOL TX #1"
              value={importedShield.isUsdcShield ? "yes" : "NO"}
              bad={!importedShield.isUsdcShield}
            />
            <Row label="execution" value={importedShield.executionStatus || "—"} />
            <Row label="pool events" value={String(importedShield.poolEvents)} />
            <Row
              label="USDC moved"
              value={importedShield.movedUsdc ? "yes" : "no"}
              bad={!importedShield.movedUsdc}
            />
            <Row
              label="USDC reached the pool"
              value={importedShield.usdcReachedPool ? "yes" : "no"}
              bad={!importedShield.usdcReachedPool}
            />
            {importedShield.reasons.length > 0 && (
              <div className={styles.notice}>{importedShield.reasons.join("; ")}</div>
            )}
          </>
        )}

        {!shieldCompleted && (
          <>
            <p className={styles.subtitle}>
              Or shield from here instead. This requires transparent USDC and a USDC allowance to
              the pool; contributions do not.
            </p>
            <div className={styles.actions}>
              <Button
                variant="ghost"
                onClick={() => void onShield(true)}
                disabled={!wallet || busy !== null}
              >
                Dry-build
              </Button>
              <Button
                onClick={() => void onShield(false)}
                disabled={
                  !wallet || busy !== null || shortfalls.length > 0 || registered !== true
                }
                title={registered !== true ? "account is not registered with the STRK20 pool" : ""}
              >
                SEND shield
              </Button>
            </div>
          </>
        )}
        {preview?.key === "shield" && <pre className={styles.pre}>{preview.text}</pre>}
        {shieldBlock !== null && (
          <Row
            label="note maturity"
            value={
              maturityRemaining === 0
                ? "mature — contributions can spend it"
                : `${maturityRemaining ?? "?"} blocks remaining`
            }
            bad={maturityRemaining !== 0}
          />
        )}
      </Step>

      {(members ?? []).map((m, i) => {
        const blockers = blockersFor(m.label);
        const settled = hasContributed(obligations, m.label);
        return (
        <Step
          key={m.label}
          n={String(7 + i)}
          name={`POOL TX #${2 + i} — contribution ${m.label}`}
          status={
            settled || txs.some((t) => t.label.startsWith(`contribution ${m.label}`))
              ? "ok"
              : "wait"
          }
        >
          <div className={styles.actions}>
            <Button
              variant="ghost"
              onClick={() => void onContribute(m, true)}
              disabled={busy !== null || blockers.length > 0}
              title={blockers.join("; ")}
            >
              Dry-build
            </Button>
            <Button
              onClick={() => void onContribute(m, false)}
              disabled={busy !== null || blockers.length > 0}
              title={blockers.join("; ")}
            >
              SEND contribution {m.label}
            </Button>
          </div>
          {settled ? (
            <>
              <Row label="obligation" value="settled — nothing further to send" />
              {!txs.some((t) => t.label.startsWith(`contribution ${m.label}`)) && (
                <>
                  <div className={styles.notice}>
                    This contribution settled on chain but no transaction hash was recorded — the
                    wallet call most likely timed out after the network accepted it. Recover the
                    hash from the circle event.
                  </div>
                  <div className={styles.actions}>
                    <Button
                      onClick={() => void onRecoverContribution(m)}
                      disabled={busy !== null || !circle || effectiveShieldBlock === null}
                    >
                      Recover hash from chain
                    </Button>
                  </div>
                </>
              )}
            </>
          ) : (
            blockers.length > 0 && (
              <div className={styles.notice}>Blocked: {blockers.join("; ")}</div>
            )
          )}
          {preview?.key === `contribution-${m.label}` && (
            <pre className={styles.pre}>{preview.text}</pre>
          )}
        </Step>
        );
      })}

      <Step n="D" name="Diagnostics (no secrets)" status={error === null ? "wait" : "bad"}>
        <p className={styles.subtitle}>
          Every wallet call this console makes, in order. Member secrets and keys never appear here.
        </p>
        {diagnostics.length === 0 ? (
          <div>No wallet calls yet.</div>
        ) : (
          <pre className={styles.pre}>{diagnostics.join("\n")}</pre>
        )}
        <div className={styles.actions}>
          <Button variant="ghost" onClick={() => setDiagnostics([])}>
            Clear log
          </Button>
        </div>
      </Step>

      <Step
        n="9"
        name="Transactions and verification"
        status={confirmedPoolHashes.length >= 3 ? "ok" : "wait"}
      >
        <Row label="confirmed pool transactions" value={`${confirmedPoolHashes.length} / 3`} />
        <div className={styles.actions}>
          <Button variant="ghost" onClick={() => void onVerifyAll()} disabled={txs.length === 0 || busy !== null}>
            Verify all
          </Button>
        </div>
        {preview?.key === "verify" && <pre className={styles.pre}>{preview.text}</pre>}
        <ul className={styles.hashList}>
          {txs.map((t) => (
            <li key={t.hash} className={styles.hashItem}>
              <div>{t.label}</div>
              <div className={styles.mono}>
                <a className={styles.link} href={voyagerTxUrl(t.hash)} target="_blank" rel="noreferrer">
                  {t.hash}
                </a>
              </div>
              {t.verification && (
                <div className={t.verification.succeeded && t.verification.touchesPool ? styles.ok : styles.warn}>
                  {t.verification.found
                    ? `${t.verification.executionStatus} · ${t.verification.finalityStatus} · pool events ${t.verification.poolEvents} · helper ${t.verification.helperEvents} · circle ${t.verification.circleEvents}`
                    : "receipt not found yet"}
                </div>
              )}
            </li>
          ))}
        </ul>
        {confirmedPoolHashes.length > 0 && (
          <pre className={styles.pre}>
            {JSON.stringify(
              {
                transactions: confirmedPoolHashes.map((t) => t.hash),
                contracts: [STARKNET_MAINNET.iwaCircle, STARKNET_MAINNET.iwaHelper],
                demo_video: "",
                demo_url: "",
              },
              null,
              2,
            )}
          </pre>
        )}
      </Step>
    </div>
  );
}
