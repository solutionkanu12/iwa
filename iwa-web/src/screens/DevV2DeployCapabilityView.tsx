// DevV2DeployCapabilityView — TEMPORARY local-only capability check for Option A
// (declare/deploy IwaCircleV2 through the Ready X browser wallet, guardian
// co-sign handled inside the wallet).
//
// Route: /dev/v2-deploy-capability. Rendered ONLY when import.meta.env.DEV is
// true (see main.tsx); tree-shaken from any production build; no nav link.
//
// It sends NOTHING. It:
//   1. reads wallet_supportedSpecs / wallet_supportedWalletApi + any injected
//      capability map on the provider
//   2. probes wallet_addDeclareTransaction with a STRUCTURALLY VALID payload
//      (the real IwaCircleV2 Sierra class) whose compiled_class_hash is
//      deliberately 0x1 — this MUST be rejected before submission/signing. The
//      rejection is classified: method-not-found -> BLOCKED, invalid-params /
//      hash-mismatch / user-cancel -> SUPPORTED, TypeError -> INCONCLUSIVE.
//   3. probes wallet_addInvokeTransaction the same way
//   4-6. checks account.declare / account.deploy / account.execute exist
//   then, only if declare is SUPPORTED, runs a NON-SENDING declare fee estimate
//   for IwaCircleV2 with a throwaway key + SKIP_VALIDATE (no wallet prompt, no
//   guardian) and confirms the class hash is still
//   0x07744b6a83f5f7b24ece1e42d9d4116077ee04f3899bfe4e48e93c0a0bb0015a.
//
// If a Ready X approval prompt ever appears during the probe: CANCEL it. The
// prompt itself proves the method exists; the probe classifies the cancel as
// SUPPORTED and no transaction is created.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Account, RpcProvider, walletV6 } from "starknet";
import type { Store } from "@starknet-io/get-starknet-discovery";

import { STARKNET_MAINNET } from "../chains/starknetProduction";
import {
  connectWallet,
  createWalletStore,
  detectWallets,
  WalletUnsupportedError,
  type ConnectedWallet,
  type DetectedWallet,
} from "../chains/strk20/walletConnect";
import {
  EXPECTED_CIRCLE_V2_CLASS,
  EXPECTED_CIRCLE_V2_COMPILED_CLASS,
  INVALID_INVOKE_PROBE_PARAMS,
  buildDeclareProbeParams,
  describeError,
  raceRequestWithTimeout,
  runDeployCapabilityProbe,
  type DeclareProbeOutcome,
  type DeployCapabilityReport,
  type EstimateShape,
  type RawContractClass,
} from "../chains/strk20/v2/deployCapabilityProbe";

const RPC_URL = "https://api.cartridge.gg/x/starknet/mainnet";
const SIERRA_URL = "/dev-v2/iwa_IwaCircleV2.contract_class.json";
/** How long to wait on the declare request before abandoning it and asking the user. */
const DECLARE_PROBE_TIMEOUT_MS = 12_000;

const box: React.CSSProperties = {
  border: "1px solid #ccc",
  borderRadius: 8,
  padding: 16,
  margin: "12px 0",
  background: "#fff",
};
const mono: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 12,
  wordBreak: "break-all",
};

type RequestFn = (call: { type: string; params?: unknown }) => Promise<unknown>;

function walletRequestFn(connected: ConnectedWallet, detected: DetectedWallet | undefined): RequestFn {
  const swo = (connected.account as unknown as { walletProvider?: unknown }).walletProvider;
  const candidates: unknown[] = [
    (swo as { features?: Record<string, { request?: unknown }> } | undefined)?.features?.[
      "starknet:walletApi"
    ]?.request,
    (swo as { request?: unknown } | undefined)?.request,
    (detected?.wallet as { features?: Record<string, { request?: unknown }> } | undefined)
      ?.features?.["starknet:walletApi"]?.request,
    (detected?.wallet as { request?: unknown } | undefined)?.request,
  ];
  const fn = candidates.find((c) => typeof c === "function") as RequestFn | undefined;
  if (!fn) throw new Error("could not locate the wallet request function");
  return fn;
}

async function outcome(
  fn: () => Promise<unknown>,
): Promise<{ ok: true; result: unknown } | { ok: false; error: unknown }> {
  try {
    return { ok: true, result: await fn() };
  } catch (e) {
    return { ok: false, error: e };
  }
}

let sierraCache: RawContractClass | null | undefined;

/** Fetches the local IwaCircleV2 Sierra artifact once. null when absent. */
async function loadSierra(): Promise<RawContractClass | null> {
  if (sierraCache !== undefined) return sierraCache;
  try {
    const res = await fetch(SIERRA_URL);
    sierraCache = res.ok ? ((await res.json()) as RawContractClass) : null;
  } catch {
    sierraCache = null;
  }
  return sierraCache;
}

/** Safe metadata off the injected provider — anything that could prove support without a call. */
function providerCapabilityHints(swo: unknown, detected: DetectedWallet | undefined): Record<string, unknown> {
  const o = (swo ?? detected?.wallet ?? {}) as Record<string, unknown>;
  const pick = (k: string) => {
    const v = o[k];
    return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : undefined;
  };
  const feat = (o.features ?? {}) as Record<string, unknown>;
  const walletApi = (feat["starknet:walletApi"] ?? {}) as Record<string, unknown>;
  return {
    keys: Object.keys(o),
    id: pick("id"),
    name: pick("name"),
    version: pick("version"),
    starknetJsVersion: pick("starknetJsVersion"),
    isConnected: pick("isConnected"),
    featureKeys: Object.keys(feat),
    walletApiVersion: typeof walletApi.version === "string" ? walletApi.version : undefined,
    walletApiWalletVersion:
      typeof walletApi.walletVersion === "string" ? walletApi.walletVersion : undefined,
    // wallet-specific method/capability maps, if any wallet ever exposes one
    methods: o.methods ?? o.capabilities ?? o.supportedMethods ?? o.rpcMethods ?? undefined,
  };
}

/**
 * NON-SENDING declare fee estimate: a throwaway key signs a SKIP_VALIDATE
 * estimate transaction against the RPC. The connected wallet is never touched,
 * so no guardian co-sign is needed.
 */
async function estimateCircleV2DeclareFee(
  address: string,
): Promise<{ estimate: EstimateShape; sierra: unknown } | null> {
  const sierra = await loadSierra();
  if (!sierra) return null;
  const provider = new RpcProvider({ nodeUrl: RPC_URL });
  // Throwaway signer — used only to sign the estimate payload that is never
  // broadcast. SKIP_VALIDATE means the chain ignores the signature entirely.
  const estAccount = new Account({ provider, address, signer: "0x1" });
  const est = (await estAccount.estimateDeclareFee(
    { contract: sierra as never, compiledClassHash: EXPECTED_CIRCLE_V2_COMPILED_CLASS },
    { skipValidate: true, blockIdentifier: "latest" },
  )) as unknown as Record<string, unknown>;
  return {
    sierra,
    estimate: {
      overall_fee: String(est.overall_fee ?? est.suggestedMaxFee ?? "?"),
      unit: typeof est.unit === "string" ? est.unit : "FRI",
      l1_gas: est.l1_gas_consumed !== undefined ? String(est.l1_gas_consumed) : undefined,
      l1_data_gas:
        est.l1_data_gas_consumed !== undefined ? String(est.l1_data_gas_consumed) : undefined,
      l2_gas: est.l2_gas_consumed !== undefined ? String(est.l2_gas_consumed) : undefined,
      resourceBounds: est.resourceBounds,
    },
  };
}

export function DevV2DeployCapabilityView() {
  const storeRef = useRef<Store | null>(null);
  const [wallets, setWallets] = useState<DetectedWallet[]>([]);
  const [connected, setConnected] = useState<ConnectedWallet | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<DeployCapabilityReport | null>(null);
  const [log, setLog] = useState<string[]>([]);
  // Interactive "did you see the Ready X prompt?" gate for the timeout path.
  const [awaitingPromptConfirm, setAwaitingPromptConfirm] = useState(false);
  const promptConfirmResolver = useRef<((v: boolean) => void) | null>(null);

  const say = useCallback((m: string) => {
    setLog((l) => [...l.slice(-80), `${new Date().toLocaleTimeString()}  ${m}`]);
  }, []);

  const confirmDeclarePrompt = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        promptConfirmResolver.current = resolve;
        setAwaitingPromptConfirm(true);
      }),
    [],
  );

  const answerPromptConfirm = useCallback((v: boolean) => {
    setAwaitingPromptConfirm(false);
    const r = promptConfirmResolver.current;
    promptConfirmResolver.current = null;
    r?.(v);
  }, []);

  useEffect(() => {
    const store = createWalletStore();
    storeRef.current = store;
    const refresh = () => void detectWallets(store).then(setWallets);
    refresh();
    return store.subscribe(refresh);
  }, []);

  const detectedFor = useMemo(
    () => (connected ? wallets.find((w) => w.name === connected.walletName) : undefined),
    [wallets, connected],
  );

  const onConnect = useCallback(
    async (detected: DetectedWallet) => {
      setError(null);
      setBusy("connecting");
      try {
        const c = await connectWallet(detected, RPC_URL);
        setConnected(c);
        say(`connected ${c.walletName} ${c.address} on ${c.chainId}`);
      } catch (e) {
        setError(e instanceof WalletUnsupportedError ? e.message : describeError(e));
      } finally {
        setBusy(null);
      }
    },
    [say],
  );

  const onRun = useCallback(async () => {
    if (!connected) return;
    setError(null);
    setReport(null);
    setBusy("probing");
    try {
      const request = walletRequestFn(connected, detectedFor);
      const swo = (connected.account as unknown as { walletProvider?: unknown }).walletProvider;

      const r = await runDeployCapabilityProbe({
        walletName: connected.walletName,
        address: connected.address,
        chainId: connected.chainId,
        supportedSpecs: () =>
          walletV6.supportedSpecs(
            (swo ?? detectedFor?.wallet) as Parameters<typeof walletV6.supportedSpecs>[0],
          ) as Promise<string[]>,
        supportedWalletApi: () =>
          walletV6.supportedWalletApi(
            (swo ?? detectedFor?.wallet) as Parameters<typeof walletV6.supportedWalletApi>[0],
          ) as Promise<string[]>,
        walletFeatureKeys: () => {
          const f =
            (swo as { features?: Record<string, unknown> } | undefined)?.features ??
            (detectedFor?.wallet as { features?: Record<string, unknown> } | undefined)?.features ??
            {};
          return Object.keys(f);
        },
        providerCapabilityHints: () => providerCapabilityHints(swo, detectedFor),
        probeAddDeclare: async (): Promise<DeclareProbeOutcome> => {
          const sierra = await loadSierra();
          if (!sierra) {
            return {
              unavailable:
                `no Sierra artifact at ${SIERRA_URL} — copy ` +
                "contracts/starknet/target/dev/iwa_IwaCircleV2.contract_class.json into " +
                "iwa-web/public/dev-v2/ and re-run (see the README there)",
            };
          }
          let params;
          try {
            params = buildDeclareProbeParams(sierra);
          } catch (e) {
            return { unavailable: `could not build a valid declare probe: ${describeError(e)}` };
          }
          say(
            "probing wallet_addDeclareTransaction with the real IwaCircleV2 class + " +
              "compiled_class_hash=0x1 (must be rejected before signing; CANCEL any prompt)…",
          );
          // Ready X's prompt cancellation does not settle the request promise —
          // race it against a timeout and abandon it rather than hang.
          const raced = await raceRequestWithTimeout(
            request({ type: "wallet_addDeclareTransaction", params }),
            DECLARE_PROBE_TIMEOUT_MS,
          );
          if (raced.kind === "resolved") {
            return { ok: true, result: raced.value, strict: true };
          }
          if (raced.kind === "rejected") {
            return { ok: false, error: raced.error, strict: true };
          }
          say(
            `no response after ${DECLARE_PROBE_TIMEOUT_MS / 1000}s — a Ready X prompt is the ` +
              "expected cause. Cancel it if still open, then answer the question below.",
          );
          return { pending: true, strict: true, timeoutMs: DECLARE_PROBE_TIMEOUT_MS };
        },
        confirmDeclarePrompt: () => {
          say("waiting: did a Ready X approval prompt appear and get cancelled?");
          return confirmDeclarePrompt();
        },
        probeAddInvoke: () => {
          say("probing wallet_addInvokeTransaction with an INVALID payload (no tx)…");
          return outcome(() =>
            request({ type: "wallet_addInvokeTransaction", params: INVALID_INVOKE_PROBE_PARAMS }),
          );
        },
        account: {
          declare: (connected.account as unknown as Record<string, unknown>).declare,
          deploy: (connected.account as unknown as Record<string, unknown>).deploy,
          execute: (connected.account as unknown as Record<string, unknown>).execute,
        },
        estimateCircleV2DeclareFee: () => {
          say("running NON-SENDING declare fee estimate (throwaway key + SKIP_VALIDATE)…");
          return estimateCircleV2DeclareFee(connected.address);
        },
      });
      setReport(r);
      say(`verdict: ${r.verdict}`);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
      setAwaitingPromptConfirm(false);
      promptConfirmResolver.current = null;
    }
  }, [connected, detectedFor, say, confirmDeclarePrompt]);

  const yesno = (b: boolean) => (b ? "yes" : "NO");
  const supportBadge = (s: string) =>
    s === "SUPPORTED" ? "#070" : s === "BLOCKED" ? "#c00" : "#a60";

  return (
    <div style={{ maxWidth: 860, margin: "24px auto", padding: 16, color: "#1a1a1a" }}>
      <h1 style={{ fontSize: 20 }}>V2 — Ready X declare/deploy capability check (DEV ONLY)</h1>
      <p style={{ fontSize: 13, color: "#555" }}>
        Local-only, not in any production build, no nav link. Starknet <strong>mainnet</strong>.
        Sends nothing. Determines whether Option A (declare + deploy IwaCircleV2 through Ready X,
        guardian co-sign inside the wallet) is available.
      </p>

      <div style={{ ...box, borderColor: "#c60", color: "#a40", background: "#fff8f0" }}>
        <strong>If a Ready X approval prompt appears during the check — CANCEL it.</strong> The
        prompt alone proves <code>wallet_addDeclareTransaction</code> exists; the probe classifies
        the cancel as SUPPORTED and no transaction is created. The probe payload has an invalid{" "}
        <code>compiled_class_hash</code> (0x1), so a correct wallet rejects it before signing.
      </div>

      {error && <div style={{ ...box, borderColor: "#c00", color: "#c00" }}>{error}</div>}

      <div style={box}>
        <h2 style={{ fontSize: 15 }}>1. Wallet</h2>
        {!connected ? (
          wallets.length === 0 ? (
            <p style={{ fontSize: 13 }}>No Starknet wallet detected. Install Ready X.</p>
          ) : (
            wallets.map((w) => (
              <button
                key={w.name}
                disabled={!!busy}
                onClick={() => void onConnect(w)}
                style={{ marginRight: 8, padding: "6px 12px" }}
              >
                Connect {w.name}
                {w.supportsStrk20 ? "" : " (no STRK20)"}
              </button>
            ))
          )
        ) : (
          <div style={{ fontSize: 13 }}>
            <strong>{connected.walletName}</strong>
            <div style={mono}>{connected.address}</div>
            <div>chainId: <span style={mono}>{connected.chainId}</span></div>
            <button
              disabled={!!busy}
              onClick={() => void onRun()}
              style={{ marginTop: 10, padding: "8px 14px" }}
            >
              {busy === "probing" ? "probing…" : "Run capability check (no tx)"}
            </button>
          </div>
        )}
      </div>

      {awaitingPromptConfirm && (
        <div style={{ ...box, borderColor: "#06c", background: "#f0f6ff" }}>
          <h2 style={{ fontSize: 15, marginTop: 0 }}>
            The wallet request did not return within {DECLARE_PROBE_TIMEOUT_MS / 1000}s
          </h2>
          <p style={{ fontSize: 13 }}>
            With this probe payload (<code>compiled_class_hash = 0x1</code>) the only expected cause
            is a <strong>Ready X approval prompt</strong>. If it is still open,{" "}
            <strong>cancel it in Ready X</strong>, then answer:
          </p>
          <p style={{ fontSize: 14, fontWeight: 600 }}>
            Did a Ready X approval prompt appear (and did you cancel it)?
          </p>
          <button
            onClick={() => answerPromptConfirm(true)}
            style={{ padding: "8px 14px", marginRight: 10, background: "#070", color: "#fff", border: 0, borderRadius: 6 }}
          >
            Yes — I saw and cancelled the Ready X prompt
          </button>
          <button
            onClick={() => answerPromptConfirm(false)}
            style={{ padding: "8px 14px", borderRadius: 6 }}
          >
            No — no prompt appeared
          </button>
          <p style={{ fontSize: 12, color: "#666", marginTop: 8 }}>
            "Yes" classifies <code>wallet_addDeclareTransaction</code> as SUPPORTED — a prompt is
            proof the method exists and reached the approval stage. No transaction was submitted; an
            accidental approval of the <code>0x1</code> payload is rejected at validation
            (COMPILED_CLASS_HASH_MISMATCH) and costs no fee.
          </p>
        </div>
      )}

      {report && (
        <div style={box}>
          <h2 style={{ fontSize: 15 }}>2. Results</h2>

          <table style={{ fontSize: 13, borderCollapse: "collapse", width: "100%" }}>
            <tbody>
              <tr>
                <td style={{ padding: "3px 12px 3px 0", verticalAlign: "top" }}>
                  1. wallet_supportedSpecs
                </td>
                <td style={mono}>
                  {Array.isArray(report.supportedSpecs)
                    ? `[${report.supportedSpecs.join(", ")}]`
                    : `error: ${report.supportedSpecs.error}`}
                </td>
              </tr>
              <tr>
                <td style={{ padding: "3px 12px 3px 0" }}>· wallet_supportedWalletApi</td>
                <td style={mono}>
                  {Array.isArray(report.supportedWalletApi)
                    ? `[${report.supportedWalletApi.join(", ")}]`
                    : `error: ${report.supportedWalletApi.error}`}
                </td>
              </tr>
              <tr>
                <td style={{ padding: "3px 12px 3px 0" }}>· wallet feature keys</td>
                <td style={mono}>[{report.walletFeatureKeys.join(", ")}]</td>
              </tr>
              <tr>
                <td style={{ padding: "3px 12px 3px 0", verticalAlign: "top" }}>
                  · provider capability hints
                </td>
                <td style={{ ...mono, whiteSpace: "pre-wrap" }}>
                  {JSON.stringify(report.providerCapabilityHints, null, 1)}
                </td>
              </tr>
              <tr>
                <td style={{ padding: "3px 12px 3px 0", verticalAlign: "top" }}>
                  2. wallet_addDeclareTransaction
                </td>
                <td>
                  <strong style={{ color: supportBadge(report.addDeclareTransaction.support) }}>
                    {report.addDeclareTransaction.support}
                  </strong>
                  {" "}
                  <span style={{ fontSize: 11, color: "#888" }}>
                    ({report.addDeclareTransaction.strictPayload
                      ? "strict payload: real class + bad compiled_class_hash"
                      : "strict payload NOT used"}
                    )
                  </span>
                  {report.addDeclareTransaction.pendingAfterTimeout && (
                    <span style={{ fontSize: 11, color: "#06c" }}>
                      {" · request timed out; "}
                      {report.addDeclareTransaction.userConfirmedPrompt
                        ? "user confirmed a Ready X prompt appeared"
                        : "no wallet prompt confirmed"}
                    </span>
                  )}
                  <div style={{ fontSize: 12, color: "#555" }}>{report.addDeclareTransaction.reason}</div>
                  {report.addDeclareTransaction.rawError && (
                    <div style={{ ...mono, color: "#777" }}>{report.addDeclareTransaction.rawError}</div>
                  )}
                </td>
              </tr>
              <tr>
                <td style={{ padding: "3px 12px 3px 0", verticalAlign: "top" }}>
                  3. wallet_addInvokeTransaction
                </td>
                <td>
                  <strong style={{ color: supportBadge(report.addInvokeTransaction.support) }}>
                    {report.addInvokeTransaction.support}
                  </strong>
                  <div style={{ fontSize: 12, color: "#555" }}>{report.addInvokeTransaction.reason}</div>
                </td>
              </tr>
              <tr>
                <td style={{ padding: "3px 12px 3px 0" }}>4. account.declare exists</td>
                <td><strong>{yesno(report.account.declare)}</strong></td>
              </tr>
              <tr>
                <td style={{ padding: "3px 12px 3px 0" }}>5. account.deploy exists</td>
                <td><strong>{yesno(report.account.deploy)}</strong></td>
              </tr>
              <tr>
                <td style={{ padding: "3px 12px 3px 0" }}>6. account.execute exists</td>
                <td><strong>{yesno(report.account.execute)}</strong></td>
              </tr>
              <tr>
                <td style={{ padding: "8px 12px 3px 0" }}>VERDICT</td>
                <td>
                  <strong style={{ fontSize: 16, color: supportBadge(report.verdict.replace("DECLARE_", "")) }}>
                    {report.verdict}
                  </strong>
                </td>
              </tr>
            </tbody>
          </table>

          <h3 style={{ fontSize: 14, marginTop: 14 }}>Declare fee estimate (non-sending)</h3>
          {!report.feeEstimate && <div style={{ fontSize: 13 }}>—</div>}
          {report.feeEstimate && "skipped" in report.feeEstimate && (
            <div style={{ fontSize: 13, color: "#a60" }}>{report.feeEstimate.skipped}</div>
          )}
          {report.feeEstimate && "ok" in report.feeEstimate && report.feeEstimate.ok && (
            <div style={{ fontSize: 13 }}>
              <div>overall_fee: <span style={mono}>{report.feeEstimate.estimate.overall_fee}</span> {report.feeEstimate.estimate.unit}</div>
              <div>computed class hash: <span style={mono}>{report.feeEstimate.classHash}</span></div>
              <div>
                matches expected{" "}
                <span style={mono}>{EXPECTED_CIRCLE_V2_CLASS}</span>:{" "}
                <strong style={{ color: report.feeEstimate.classHashMatchesExpected ? "#070" : "#c00" }}>
                  {report.feeEstimate.classHashMatchesExpected ? "yes" : "NO"}
                </strong>
              </div>
            </div>
          )}
          {report.feeEstimate && "ok" in report.feeEstimate && !report.feeEstimate.ok && (
            <div style={{ ...mono, color: "#c00" }}>{report.feeEstimate.error}</div>
          )}

          <pre style={{ ...mono, whiteSpace: "pre-wrap", background: "#f6f6f6", padding: 8, marginTop: 12 }}>
            {JSON.stringify(report, null, 2)}
          </pre>
        </div>
      )}

      <div style={box}>
        <h2 style={{ fontSize: 15 }}>Log</h2>
        <pre style={{ ...mono, whiteSpace: "pre-wrap", maxHeight: 260, overflow: "auto" }}>
          {log.join("\n") || "—"}
        </pre>
      </div>

      <p style={{ fontSize: 12, color: "#888" }}>
        pool fee token (context): {STARKNET_MAINNET.strkToken}
      </p>
    </div>
  );
}
