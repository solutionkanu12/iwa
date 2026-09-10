// DevNoteIdProbeView — TEMPORARY local-only diagnostic for the Candidate P A1
// gate (docs/strk20/WALLET_NOTE_ID_SPIKE.md).
//
// Route: /dev/note-id-probe. Rendered ONLY when import.meta.env.DEV is true
// (see main.tsx); tree-shaken out of any production build; no navigation link.
//
// Transactions: the "Capture shape", "Run Prepare #1+#2" and "Re-verify"
// buttons run `wallet_strk20PrepareInvoke(simulate)` only and send NOTHING.
// The "Intervening-note test" button is the ONLY one that sends a transaction;
// it is behind an explicit confirm and a no-transaction re-verify guard.
//
// Forensic build: shows the SAFE structural fingerprint of every prepare
// response so a flake can be told apart from a genuine wallet limitation.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RpcProvider, walletV6 } from "starknet";
import type { Store } from "@starknet-io/get-starknet-discovery";

import { STARKNET_MAINNET, voyagerTxUrl } from "../chains/starknetProduction";
import {
  connectWallet,
  createWalletStore,
  detectWallets,
  REQUIRED_WALLET_API_VERSION,
  supportsStrk20,
  WalletUnsupportedError,
  type ConnectedWallet,
  type DetectedWallet,
} from "../chains/strk20/walletConnect";
import {
  captureShape,
  runNoteIdStabilityProbe,
  type PrepareInspection,
  type ProbeResult,
  type ProbeWallet,
} from "../chains/strk20/noteIdStabilityProbe";

const RPC_URL = "https://api.cartridge.gg/x/starknet/mainnet";
const DISCOVERY_LAG_BLOCKS = 3;

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

function hex(v: string): string {
  return `0x${BigInt(v).toString(16)}`;
}
function idText(v: bigint | null | undefined): string {
  return v === null || v === undefined ? "—" : `0x${v.toString(16)}`;
}

function InspectionBlock({ label, insp }: { label: string; insp: PrepareInspection }) {
  return (
    <details style={{ margin: "6px 0" }}>
      <summary style={{ fontSize: 13, cursor: "pointer" }}>
        {label}: {insp.ok ? "ok" : "ERROR"}
        {insp.retried ? " (after retry)" : ""}
        {insp.error ? ` — ${insp.error}` : ""}
        {" · "}resolved id candidates: {insp.resolvedIdCandidatesHex.length}
        {insp.placeholderLiteralPaths.length ? " · UNRESOLVED placeholder present" : ""}
      </summary>
      <pre style={{ ...mono, whiteSpace: "pre-wrap", background: "#f6f6f6", padding: 8 }}>
        {JSON.stringify(insp, null, 2)}
      </pre>
    </details>
  );
}

export function DevNoteIdProbeView() {
  const provider = useMemo(() => new RpcProvider({ nodeUrl: RPC_URL }), []);
  const storeRef = useRef<Store | null>(null);
  const [wallets, setWallets] = useState<DetectedWallet[]>([]);
  const [connected, setConnected] = useState<ConnectedWallet | null>(null);
  const [apiVersions, setApiVersions] = useState<string[]>([]);
  const [token, setToken] = useState<"usdc" | "strk">("usdc");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [shape, setShape] = useState<PrepareInspection | null>(null);
  /** A resolved id a stable "Run Prepare #1+#2" produced this session. */
  const [baselineId, setBaselineId] = useState<bigint | null>(null);

  const say = useCallback((m: string) => {
    setLog((l) => [...l, `${new Date().toLocaleTimeString()}  ${m}`]);
  }, []);

  useEffect(() => {
    const store = createWalletStore();
    storeRef.current = store;
    const refresh = () => void detectWallets(store).then(setWallets);
    refresh();
    return store.subscribe(refresh);
  }, []);

  const tokenAddress =
    token === "usdc" ? STARKNET_MAINNET.usdcToken : STARKNET_MAINNET.strkToken;
  // A real deployed contract that HAS a `privacy_invoke` selector, so the
  // wallet's compile step does not trip on an unknown target. simulate never
  // executes it, so the garbage calldata is harmless.
  const probeContract = STARKNET_MAINNET.iwaHelper;

  const onConnect = useCallback(
    async (detected: DetectedWallet) => {
      setError(null);
      setBusy("connecting");
      try {
        const c = await connectWallet(detected, RPC_URL);
        setConnected(c);
        let versions = detected.apiVersions.slice();
        try {
          versions = await walletV6.supportedWalletApi(
            detected.wallet as Parameters<typeof walletV6.supportedWalletApi>[0],
          );
        } catch {
          /* keep the discovery-time list */
        }
        setApiVersions(versions);
        say(`connected ${c.walletName} ${c.address} on ${c.chainId}`);
        say(`supportedWalletApi: [${versions.join(", ")}]`);
      } catch (e) {
        setError(e instanceof WalletUnsupportedError ? e.message : (e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [say],
  );

  const probeWallet = useCallback((): ProbeWallet => {
    if (!connected) throw new Error("no wallet connected");
    const account = connected.account as unknown as {
      strk20PrepareInvoke: ProbeWallet["strk20PrepareInvoke"];
      strk20InvokeTransaction: ProbeWallet["strk20InvokeTransaction"];
    };
    return {
      supportedWalletApi: async () => apiVersions,
      strk20PrepareInvoke: (actions, simulate) => account.strk20PrepareInvoke(actions, simulate),
      strk20InvokeTransaction: (actions) => account.strk20InvokeTransaction(actions),
    };
  }, [connected, apiVersions]);

  const probeArgs = useCallback(
    () => ({
      wallet: probeWallet(),
      token: tokenAddress,
      selfAddress: connected!.address,
      probeContract,
      requiredWalletApiVersion: REQUIRED_WALLET_API_VERSION,
      onStep: say,
    }),
    [probeWallet, tokenAddress, connected, probeContract, say],
  );

  const captureRaw = useCallback(async () => {
    if (!connected) return;
    setError(null);
    setShape(null);
    setBusy("capture");
    say("— Capture raw prepare shape (1 call, no transaction) —");
    try {
      const c = await captureShape(probeWallet(), {
        token: tokenAddress,
        selfAddress: connected.address,
        probeContract,
      });
      setShape(c.inspection);
      say(
        `resolved id: ${idText(c.id)}${c.foundAt ? ` at ${c.foundAt}` : ""} · ` +
          `poolAddress placeholder resolved: ${c.inspection.poolAddressPlaceholderResolved}`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [connected, probeWallet, tokenAddress, probeContract, say]);

  const runPrepareOnly = useCallback(async () => {
    if (!connected) return;
    setError(null);
    setResult(null);
    setBusy("prepare");
    say("— Prepare probe #1 + #2 (no transaction) —");
    try {
      const r = await runNoteIdStabilityProbe(probeArgs());
      setResult(r);
      say(`verdict: ${r.verdict}`);
      if (r.observed.first !== null && r.observed.first === r.observed.second) {
        setBaselineId(r.observed.first);
        say(`baseline id captured: 0x${r.observed.first.toString(16)}`);
      } else {
        setBaselineId(null);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [connected, probeArgs, say]);

  const reVerify = useCallback(async () => {
    if (!connected || baselineId === null) return;
    setError(null);
    setResult(null);
    setBusy("reverify");
    say(`— Re-verify baseline 0x${baselineId.toString(16)} (1 call, no transaction) —`);
    try {
      const r = await runNoteIdStabilityProbe({ ...probeArgs(), priorStableId: baselineId });
      setResult(r);
      say(`verdict: ${r.verdict}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [connected, baselineId, probeArgs, say]);

  const runInterveningNote = useCallback(async () => {
    if (!connected || baselineId === null) return;
    if (
      !window.confirm(
        "This SENDS a mainnet transaction: a 1-unit deposit of the selected token into the " +
          "STRK20 pool (plus the pool fee, ~6 STRK). You will approve it in Ready. Continue?",
      )
    ) {
      return;
    }
    setError(null);
    setResult(null);
    setBusy("intervening");
    say("— Intervening-note test —");
    try {
      say("guard: re-verifying the baseline before spending…");
      const guard = await runNoteIdStabilityProbe({ ...probeArgs(), priorStableId: baselineId });
      if (guard.verdict !== "PARTIAL_STABLE_PENDING_SHIFT") {
        setResult(guard);
        say(`guard verdict ${guard.verdict} — NOT proceeding to the deposit`);
        return;
      }
      const account = connected.account as unknown as {
        strk20InvokeTransaction: ProbeWallet["strk20InvokeTransaction"];
      };
      const r = await runNoteIdStabilityProbe({
        ...probeArgs(),
        priorStableId: baselineId,
        createInterveningNote: async () => {
          say("submitting a 1-unit deposit — approve it in Ready (you may be prompted twice)");
          const { transaction_hash } = await account.strk20InvokeTransaction([
            { type: "deposit", token: hex(tokenAddress), amount: "0x1" },
          ]);
          say(`deposit submitted: ${transaction_hash}`);
          say(`  ${voyagerTxUrl(transaction_hash)}`);
          await provider.waitForTransaction(transaction_hash);
          const base = await provider.getBlockNumber();
          say(`deposit mined at block ${base}; waiting ${DISCOVERY_LAG_BLOCKS} blocks`);
          for (;;) {
            await new Promise((res) => setTimeout(res, 12_000));
            const now = await provider.getBlockNumber();
            if (now - base >= DISCOVERY_LAG_BLOCKS) break;
          }
        },
      });
      setResult(r);
      say(`verdict: ${r.verdict}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [connected, baselineId, probeArgs, tokenAddress, provider, say]);

  const o = result?.observed;
  const match =
    o && o.first !== null && o.second !== null
      ? o.first === o.second
        ? "MATCH"
        : "MISMATCH"
      : "—";
  const shifted =
    o && o.first !== null && o.afterInterveningNote !== null
      ? o.afterInterveningNote === o.first
        ? "did NOT shift"
        : "shifted"
      : "—";

  return (
    <div style={{ maxWidth: 860, margin: "24px auto", padding: 16, color: "#1a1a1a" }}>
      <h1 style={{ fontSize: 20 }}>A1 — note-id stability probe (DEV ONLY)</h1>
      <p style={{ fontSize: 13, color: "#555" }}>
        Local-only, not in any production build, no navigation link. Starknet
        <strong> mainnet</strong> only. The <em>Capture</em>, <em>Prepare #1+#2</em>{" "}
        and <em>Re-verify</em> buttons run <code>simulate</code> and send{" "}
        <strong>nothing</strong>. Only <em>Intervening-note test</em> sends a
        transaction, behind a confirm + a no-transaction re-verify guard. See{" "}
        <code>docs/strk20/WALLET_NOTE_ID_SPIKE.md</code>.
      </p>

      {error && <div style={{ ...box, borderColor: "#c00", color: "#c00" }}>{error}</div>}

      <div style={box}>
        <h2 style={{ fontSize: 15 }}>1. Wallet</h2>
        {!connected ? (
          wallets.length === 0 ? (
            <p style={{ fontSize: 13 }}>No Starknet wallet detected. Install Ready.</p>
          ) : (
            wallets.map((w) => (
              <button
                key={w.name}
                disabled={!!busy}
                onClick={() => void onConnect(w)}
                style={{ marginRight: 8, padding: "6px 12px" }}
              >
                Connect {w.name}
                {w.supportsStrk20 ? "" : " (no STRK20 API)"}
              </button>
            ))
          )
        ) : (
          <div style={{ fontSize: 13 }}>
            <div>
              <strong>{connected.walletName}</strong>
            </div>
            <div style={mono}>{connected.address}</div>
            <div>
              chainId: <span style={mono}>{connected.chainId}</span>
            </div>
          </div>
        )}
      </div>

      {connected && (
        <>
          <div style={box}>
            <h2 style={{ fontSize: 15 }}>2. supportedWalletApi</h2>
            <div style={mono}>[{apiVersions.join(", ")}]</div>
            <div style={{ fontSize: 13, marginTop: 4 }}>
              carries STRK20 methods (&ge; {REQUIRED_WALLET_API_VERSION}):{" "}
              <strong>{supportsStrk20(apiVersions) ? "yes" : "NO"}</strong>
            </div>
          </div>

          <div style={box}>
            <h2 style={{ fontSize: 15 }}>3. Run</h2>
            <label style={{ fontSize: 13, marginRight: 12 }}>
              <input
                type="radio"
                checked={token === "usdc"}
                onChange={() => setToken("usdc")}
                disabled={!!busy}
              />{" "}
              USDC
            </label>
            <label style={{ fontSize: 13 }}>
              <input
                type="radio"
                checked={token === "strk"}
                onChange={() => setToken("strk")}
                disabled={!!busy}
              />{" "}
              STRK
            </label>
            <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button disabled={!!busy} onClick={() => void captureRaw()} style={{ padding: "8px 12px" }}>
                {busy === "capture" ? "…" : "Capture raw prepare shape (no tx)"}
              </button>
              <button disabled={!!busy} onClick={() => void runPrepareOnly()} style={{ padding: "8px 12px" }}>
                {busy === "prepare" ? "…" : "Run Prepare #1 + #2 (no tx)"}
              </button>
              <button
                disabled={!!busy || baselineId === null}
                onClick={() => void reVerify()}
                style={{ padding: "8px 12px" }}
              >
                {busy === "reverify" ? "…" : "Re-verify baseline (no tx)"}
              </button>
              <button
                disabled={!!busy || baselineId === null}
                onClick={() => void runInterveningNote()}
                style={{ padding: "8px 12px", borderColor: "#c60", color: "#c60" }}
              >
                {busy === "intervening" ? "…" : "Intervening-note test — SENDS A DEPOSIT"}
              </button>
            </div>
            <div style={{ fontSize: 12, color: "#777", marginTop: 6 }}>
              baseline id this session:{" "}
              <span style={mono}>{baselineId === null ? "none" : `0x${baselineId.toString(16)}`}</span>
            </div>
          </div>

          {shape && (
            <div style={box}>
              <h2 style={{ fontSize: 15 }}>Raw prepare shape</h2>
              <InspectionBlock label="capture" insp={shape} />
            </div>
          )}

          {result && (
            <div style={box}>
              <h2 style={{ fontSize: 15 }}>4. Result</h2>
              <table style={{ fontSize: 13, borderCollapse: "collapse" }}>
                <tbody>
                  <tr>
                    <td style={{ padding: "2px 12px 2px 0" }}>Prepare #1 resolved id</td>
                    <td style={mono}>{idText(o?.first)}</td>
                  </tr>
                  <tr>
                    <td style={{ padding: "2px 12px 2px 0" }}>Prepare #2 resolved id</td>
                    <td style={mono}>{idText(o?.second)}</td>
                  </tr>
                  <tr>
                    <td style={{ padding: "2px 12px 2px 0" }}>#1 vs #2</td>
                    <td>
                      <strong>{match}</strong>
                    </td>
                  </tr>
                  <tr>
                    <td style={{ padding: "2px 12px 2px 0" }}>Prepare #3 id (after note)</td>
                    <td style={mono}>{idText(o?.afterInterveningNote)}</td>
                  </tr>
                  <tr>
                    <td style={{ padding: "2px 12px 2px 0" }}>#3 vs #1</td>
                    <td>{shifted}</td>
                  </tr>
                  <tr>
                    <td style={{ padding: "6px 12px 2px 0" }}>A1 verdict</td>
                    <td>
                      <strong style={{ fontSize: 15 }}>{result.verdict}</strong>
                    </td>
                  </tr>
                </tbody>
              </table>
              {result.detail && (
                <p style={{ fontSize: 13, color: "#555", marginTop: 6 }}>{result.detail}</p>
              )}
              {(o?.inspections ?? []).map((insp, i) => (
                <InspectionBlock key={i} label={`prepare call ${i + 1}`} insp={insp} />
              ))}
            </div>
          )}
        </>
      )}

      <div style={box}>
        <h2 style={{ fontSize: 15 }}>Log</h2>
        <pre style={{ ...mono, whiteSpace: "pre-wrap", maxHeight: 280, overflow: "auto" }}>
          {log.join("\n") || "—"}
        </pre>
      </div>
    </div>
  );
}
