// DevV2PotCollectionView — TEMPORARY local-only flow for ONE real Starknet
// mainnet private pot collection proof (Candidate P / IwaCircleV2).
//
// Route: /dev/v2-pot-collection. Rendered ONLY when import.meta.env.DEV is true
// (see main.tsx); tree-shaken out of any production build; no navigation link.
// V1 routes and screens are untouched.
//
// This screen is inert until IwaCircleV2 / IwaStrk20HelperV2 are deployed and
// their addresses filled into src/chains/strk20/v2/deploymentV2.ts. Until then
// it shows the deployment gate and the Collect button is disabled.
//
// It sends NOTHING automatically: the member types their circle id + round +
// identity, then clicks Collect, and every wallet prompt (the plain
// register_payout_destination call, then the STRK20 settlement) is approved in
// the wallet. "Paid" is shown only after a fresh on-chain read confirms
// PayoutStatusV2 == PrivatelyPaid.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RpcProvider } from "starknet";
import type { Store } from "@starknet-io/get-starknet-discovery";

import { STARKNET_MAINNET, voyagerTxUrl } from "../chains/starknetProduction";
import {
  connectWallet,
  createWalletStore,
  detectWallets,
  WalletUnsupportedError,
  type ConnectedWallet,
  type DetectedWallet,
} from "../chains/strk20/walletConnect";
import { deriveMemberIdentity, feltHex } from "../chains/strk20/iwaSigning";
import {
  isV2Deployed,
  requireV2Deployment,
  STARKNET_MAINNET_V2,
} from "../chains/strk20/v2/deploymentV2";
import {
  collectPrivatePot,
  type PotCollectionState,
  type WalletBridge,
} from "../chains/strk20/v2/privatePotCollection";
import { getCircleV2, getPayoutStateV2, makeProvider } from "../chains/strk20/v2/publicReadsV2";

const RPC_URL = "https://api.cartridge.gg/x/starknet/mainnet";

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

const PHASE_LABEL: Record<PotCollectionState["phase"], string> = {
  "checking-state": "reading the round's payout state…",
  "already-collected": "already collected — nothing to do",
  "not-your-turn": "the connected member is not this round's recipient",
  "not-collectable": "this round's pot cannot be collected right now",
  "preparing-note-id": "resolving the open-note id (wallet simulate, no tx)…",
  "awaiting-registration-signature": "sign the destination registration in your wallet…",
  registering: "submitting register_payout_destination…",
  registered: "destination registered",
  "assembling-settlement": "re-checking the open-note id, assembling settlement…",
  "awaiting-settlement-approval": "approve the STRK20 settlement in your wallet…",
  settling: "submitting the private settlement…",
  confirming: "confirming PrivatelyPaid on chain…",
  paid: "PAID — confirmed on chain",
  failed: "failed",
};

export function DevV2PotCollectionView() {
  const provider = useMemo<RpcProvider>(() => makeProvider(RPC_URL), []);
  const storeRef = useRef<Store | null>(null);
  const [wallets, setWallets] = useState<DetectedWallet[]>([]);
  const [connected, setConnected] = useState<ConnectedWallet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [states, setStates] = useState<PotCollectionState[]>([]);

  const [circleId, setCircleId] = useState("");
  const [round, setRound] = useState("");
  const [secret, setSecret] = useState("");
  const [privKey, setPrivKey] = useState("");

  const say = useCallback((m: string) => {
    setLog((l) => [...l.slice(-60), `${new Date().toLocaleTimeString()}  ${m}`]);
  }, []);

  useEffect(() => {
    const store = createWalletStore();
    storeRef.current = store;
    const refresh = () => void detectWallets(store).then(setWallets);
    refresh();
    return store.subscribe(refresh);
  }, []);

  const deployed = isV2Deployed();
  const v2 = deployed ? requireV2Deployment() : null;

  const onConnect = useCallback(
    async (detected: DetectedWallet) => {
      setError(null);
      setBusy(true);
      try {
        const c = await connectWallet(detected, RPC_URL);
        setConnected(c);
        say(`connected ${c.walletName} ${c.address}`);
      } catch (e) {
        setError(e instanceof WalletUnsupportedError ? e.message : (e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [say],
  );

  const onCollect = useCallback(async () => {
    if (!connected || !v2) return;
    setError(null);
    setStates([]);
    setBusy(true);

    const parseFelt = (v: string, what: string): bigint => {
      const t = v.trim();
      if (!/^0x[0-9a-fA-F]{1,64}$/.test(t)) throw new Error(`${what} must be a 0x hex felt`);
      const n = BigInt(t);
      if (n === 0n) throw new Error(`${what} must not be zero`);
      return n;
    };

    try {
      const cid = Number(circleId);
      const rnd = Number(round);
      if (!Number.isInteger(cid) || cid <= 0) throw new Error("enter a circle id");
      if (!Number.isInteger(rnd) || rnd <= 0) throw new Error("enter a round");

      const identity = deriveMemberIdentity(
        "member",
        parseFelt(secret, "invite secret"),
        parseFelt(privKey, "auth private key"),
      );
      say(`member_ref ${feltHex(identity.memberRef)}`);

      const circle = await getCircleV2(provider, v2.circleV2, cid);
      const token =
        circle.asset === "Usdc" ? STARKNET_MAINNET.usdcToken : STARKNET_MAINNET.strkToken;
      say(`circle ${cid}: ${circle.status}, round ${circle.currentRound}, asset ${circle.asset}`);

      const payout = await getPayoutStateV2(provider, v2.circleV2, cid, rnd);
      say(`payout state round ${rnd}: ${payout ? payout.status : "none"}`);

      const acct = connected.account as unknown as {
        strk20PrepareInvoke: WalletBridge["strk20PrepareInvoke"];
        strk20InvokeTransaction: WalletBridge["strk20InvokeTransaction"];
        execute: (calls: unknown[]) => Promise<{ transaction_hash: string }>;
      };
      const wallet: WalletBridge = {
        strk20PrepareInvoke: (a, s) => acct.strk20PrepareInvoke(a, s),
        strk20InvokeTransaction: (a) => acct.strk20InvokeTransaction(a),
        execute: (calls) => acct.execute(calls),
        waitForTransaction: async (h) => {
          say(`waiting for ${h}`);
          await provider.waitForTransaction(h);
        },
      };

      const result = await collectPrivatePot({
        provider,
        circleV2Address: v2.circleV2,
        helperV2Address: v2.helperV2,
        poolAddress: v2.pool,
        circleId: cid,
        round: rnd,
        token,
        identity,
        selfAddress: connected.address,
        wallet,
        onState: (st) => {
          setStates((prev) => [...prev, st]);
          say(
            `${st.phase}${st.detail ? ` — ${st.detail}` : ""}` +
              (st.registrationTxHash ? ` reg=${st.registrationTxHash}` : "") +
              (st.settlementTxHash ? ` settle=${st.settlementTxHash}` : ""),
          );
        },
      });
      say(`RESULT: ${result.phase}${result.retryable ? " (retryable)" : ""}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [connected, v2, circleId, round, secret, privKey, provider, say]);

  const last = states[states.length - 1];

  return (
    <div style={{ maxWidth: 820, margin: "24px auto", padding: 16, color: "#1a1a1a" }}>
      <h1 style={{ fontSize: 20 }}>V2 — private pot collection (DEV ONLY)</h1>
      <p style={{ fontSize: 13, color: "#555" }}>
        Local-only, not in any production build, no navigation link. Starknet <strong>mainnet</strong>{" "}
        only. Candidate P: register a precommitted private destination, then settle privately through
        the pinned STRK20 pool. Nothing sends without a button click and a wallet approval.
      </p>

      {!deployed && (
        <div style={{ ...box, borderColor: "#c60", color: "#a40" }}>
          <strong>IWA V2 is not deployed.</strong> IwaCircleV2 / IwaStrk20HelperV2 addresses are
          unset in <code>src/chains/strk20/v2/deploymentV2.ts</code>. Fill them from a real mainnet
          declare/deploy and re-run the class-hash preflight before using this screen.
          <div style={{ ...mono, marginTop: 6 }}>
            iwaCircleV2: {JSON.stringify(STARKNET_MAINNET_V2.iwaCircleV2)} · iwaHelperV2:{" "}
            {JSON.stringify(STARKNET_MAINNET_V2.iwaHelperV2)}
          </div>
        </div>
      )}

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
                disabled={busy}
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
          </div>
        )}
      </div>

      <div style={box}>
        <h2 style={{ fontSize: 15 }}>2. Circle, round, member identity (memory only)</h2>
        <p style={{ fontSize: 12, color: "#777" }}>
          Held for this session only — never stored, never logged.
        </p>
        {(
          [
            ["Circle id", circleId, setCircleId, "text"],
            ["Round", round, setRound, "text"],
            ["Invite secret (0x…)", secret, setSecret, "password"],
            ["Auth private key (0x…)", privKey, setPrivKey, "password"],
          ] as const
        ).map(([label, value, setter, type]) => (
          <label key={label} style={{ display: "block", margin: "6px 0", fontSize: 13 }}>
            {label}
            <input
              style={{ display: "block", width: "100%", padding: 6, fontFamily: mono.fontFamily }}
              type={type}
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(e) => setter(e.target.value)}
            />
          </label>
        ))}
        <button
          disabled={busy || !connected || !deployed}
          onClick={() => void onCollect()}
          style={{ padding: "8px 14px", marginTop: 8 }}
        >
          {busy ? "working…" : "Collect my pot privately"}
        </button>
      </div>

      {states.length > 0 && (
        <div style={box}>
          <h2 style={{ fontSize: 15 }}>3. Progress</h2>
          <div
            style={{
              fontSize: 15,
              fontWeight: 700,
              color: last?.phase === "paid" ? "#070" : last?.phase === "failed" ? "#c00" : "#333",
            }}
          >
            {last ? PHASE_LABEL[last.phase] : ""}
          </div>
          {last?.detail && <p style={{ fontSize: 13, color: "#555" }}>{last.detail}</p>}
          {last?.retryable && last.phase === "failed" && (
            <p style={{ fontSize: 13, color: "#a40" }}>
              The on-chain payout state still permits another attempt — press Collect again.
            </p>
          )}
          {last?.registrationTxHash && (
            <div style={mono}>
              registration:{" "}
              <a href={voyagerTxUrl(last.registrationTxHash)} target="_blank" rel="noreferrer">
                {last.registrationTxHash}
              </a>
            </div>
          )}
          {last?.settlementTxHash && (
            <div style={mono}>
              settlement:{" "}
              <a href={voyagerTxUrl(last.settlementTxHash)} target="_blank" rel="noreferrer">
                {last.settlementTxHash}
              </a>
            </div>
          )}
          <ol style={{ fontSize: 12, color: "#666", marginTop: 8 }}>
            {states.map((s, i) => (
              <li key={i}>{s.phase}</li>
            ))}
          </ol>
        </div>
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
