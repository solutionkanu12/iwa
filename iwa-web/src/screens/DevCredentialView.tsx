// DevCredentialView — TEMPORARY local-only Portable Trust Credential flow:
// generate an `iwa-credential/2` artifact, and verify one against Starknet
// mainnet with a proof-of-possession challenge.
//
// Route: /dev/credential. Rendered ONLY when import.meta.env.DEV is true (see
// main.tsx); tree-shaken out of any production build; no navigation link.
// V1 routes and screens are untouched.
//
// Nothing signs or sends a transaction. The artifact signature and the
// possession response are off-chain Stark-curve ECDSA over Poseidon digests,
// produced from a session-only key the member types in. Chain access is
// read-only (view calls) against the pinned IwaCircleV2 address.
//
// This screen is inert until IwaCircleV2 is deployed and its address is filled
// into src/chains/strk20/v2/deploymentV2.ts.

import { useCallback, useMemo, useState } from "react";
import { RpcProvider } from "starknet";

import { deriveMemberIdentity } from "../chains/strk20/iwaSigning";
import { isV2Deployed, requireV2Deployment } from "../chains/strk20/v2/deploymentV2";
import { makeProvider } from "../chains/strk20/v2/publicReadsV2";
import {
  parseArtifactV2,
  serializeArtifactV2,
  signPossessionV2,
  type PossessionResponse,
} from "../lib/credential/artifact";
import type { PossessionChallenge } from "../lib/credential/claims";
import { makeCredentialChainReader } from "../lib/credential/credentialChainReader";
import { generateCredentialV2 } from "../lib/credential/generate";
import { verifyCredentialV2, type VerifyResult } from "../lib/credential/verify";

const RPC_URL = "https://api.cartridge.gg/x/starknet/mainnet";
const NETWORK = "SN_MAIN";
/** This verifier's identity — bound into every challenge it issues. */
const VERIFIER_ID = "iwa-credential-verifier";
/** A possession challenge is good for five minutes. */
const CHALLENGE_TTL_SECONDS = 300;

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
const input: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: 6,
  fontFamily: mono.fontFamily,
  fontSize: 12,
};
const btn: React.CSSProperties = { padding: "8px 14px", marginTop: 8 };

function parseFelt(v: string, what: string): bigint {
  const t = v.trim();
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(t)) throw new Error(`${what} must be a 0x hex felt`);
  const n = BigInt(t);
  if (n === 0n) throw new Error(`${what} must not be zero`);
  return n;
}

function randomNonce(): string {
  const b = new Uint8Array(31);
  crypto.getRandomValues(b);
  let acc = 0n;
  for (const x of b) acc = (acc << 8n) | BigInt(x);
  return `0x${acc.toString(16)}`;
}

async function latestBlock(provider: RpcProvider): Promise<{ number: number; timestamp: number }> {
  const b = (await provider.getBlock("latest")) as unknown as {
    block_number: number;
    timestamp: number;
  };
  return { number: b.block_number, timestamp: b.timestamp };
}

export function DevCredentialView() {
  const provider = useMemo<RpcProvider>(() => makeProvider(RPC_URL), []);
  const deployed = isV2Deployed();
  const circleV2 = deployed ? requireV2Deployment().circleV2 : null;
  const chain = useMemo(
    () => (circleV2 ? makeCredentialChainReader({ circleV2Address: circleV2, nodeUrl: RPC_URL }) : null),
    [circleV2],
  );

  return (
    <div style={{ maxWidth: 860, margin: "24px auto", padding: 16, color: "#1a1a1a" }}>
      <h1 style={{ fontSize: 20 }}>Portable Trust Credential (DEV ONLY)</h1>
      <p style={{ fontSize: 13, color: "#555" }}>
        Local-only, not in any production build, no navigation link. The artifact is an off-chain
        signed statement of facts that are already public on <strong>IwaCircleV2</strong>; the
        verifier re-derives every fact from chain and additionally demands a fresh, verifier-bound
        proof that the holder still controls the key. A copied JSON file alone never verifies.
        Nothing here signs or sends a transaction.
      </p>

      {!deployed && (
        <div style={{ ...box, borderColor: "#c60", color: "#a40" }}>
          <strong>IWA V2 is not deployed.</strong> The IwaCircleV2 address is unset in{" "}
          <code>src/chains/strk20/v2/deploymentV2.ts</code>. Generation and verification both stay
          disabled until it is filled from a real mainnet deploy.
        </div>
      )}

      <GeneratePanel chain={chain} provider={provider} circleV2={circleV2} />
      <VerifyPanel chain={chain} circleV2={circleV2} />
    </div>
  );
}

function GeneratePanel(props: {
  chain: ReturnType<typeof makeCredentialChainReader> | null;
  provider: RpcProvider;
  circleV2: string | null;
}) {
  const [circleId, setCircleId] = useState("");
  const [claimType, setClaimType] = useState<"good_standing" | "circle_completion">("good_standing");
  const [n, setN] = useState("");
  const [secret, setSecret] = useState("");
  const [privKey, setPrivKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [artifactJson, setArtifactJson] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const onGenerate = useCallback(async () => {
    if (!props.chain || !props.circleV2) return;
    setBusy(true);
    setError(null);
    setArtifactJson(null);
    setCopied(false);
    try {
      const cid = Number(circleId);
      if (!Number.isInteger(cid) || cid <= 0) throw new Error("enter a circle id");
      const identity = deriveMemberIdentity(
        "member",
        parseFelt(secret, "invite secret"),
        parseFelt(privKey, "auth private key"),
      );
      const thresholdRounds =
        claimType === "good_standing" ? Number(n) : undefined;
      if (claimType === "good_standing" && (!Number.isInteger(thresholdRounds) || (thresholdRounds ?? 0) < 1)) {
        throw new Error("Good Standing needs a round count N ≥ 1");
      }
      const block = await latestBlock(props.provider);
      const res = await generateCredentialV2({
        identity,
        claimType,
        thresholdRounds,
        network: NETWORK,
        circleId: cid,
        chain: props.chain,
        iwaCircleV2: props.circleV2,
        issuedAtBlock: block.number,
        issuedAt: block.timestamp,
      });
      if (!res.ok) {
        setError(`Not issued — ${res.reason}`);
        return;
      }
      setArtifactJson(serializeArtifactV2(res.artifact));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [props.chain, props.circleV2, props.provider, circleId, claimType, n, secret, privKey]);

  return (
    <div style={box}>
      <h2 style={{ fontSize: 15 }}>Generate a credential</h2>
      <p style={{ fontSize: 12, color: "#777" }}>
        The invite secret and auth key are held for this session only — never stored, never logged,
        never sent anywhere. The credential is only issued if the claim already holds on chain.
      </p>

      <label style={{ display: "block", margin: "6px 0", fontSize: 13 }}>
        Claim
        <select
          style={{ ...input }}
          value={claimType}
          onChange={(e) => setClaimType(e.target.value as "good_standing" | "circle_completion")}
        >
          <option value="good_standing">Good Standing (completed N qualifying rounds)</option>
          <option value="circle_completion">Circle Completion (own private payout settled)</option>
        </select>
      </label>

      {(
        [
          ["Circle id", circleId, setCircleId, "text"],
          ...(claimType === "good_standing"
            ? ([["Rounds N", n, setN, "text"]] as const)
            : ([] as const)),
          ["Invite secret (0x…)", secret, setSecret, "password"],
          ["Auth private key (0x…)", privKey, setPrivKey, "password"],
        ] as const
      ).map(([label, value, setter, type]) => (
        <label key={label} style={{ display: "block", margin: "6px 0", fontSize: 13 }}>
          {label}
          <input
            style={input}
            type={type}
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setter(e.target.value)}
          />
        </label>
      ))}

      <button style={btn} disabled={busy || !props.chain} onClick={() => void onGenerate()}>
        {busy ? "checking chain…" : "Generate credential"}
      </button>

      {error && <div style={{ ...box, borderColor: "#c00", color: "#c00" }}>{error}</div>}

      {artifactJson && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#070" }}>Issued.</div>
          <pre style={{ ...mono, whiteSpace: "pre-wrap", background: "#f6f6f6", padding: 10, borderRadius: 6 }}>
            {artifactJson}
          </pre>
          <button
            style={{ padding: "6px 12px" }}
            onClick={() => {
              void navigator.clipboard?.writeText(artifactJson);
              setCopied(true);
            }}
          >
            {copied ? "copied" : "Copy JSON"}
          </button>
        </div>
      )}
    </div>
  );
}

function VerifyPanel(props: {
  chain: ReturnType<typeof makeCredentialChainReader> | null;
  circleV2: string | null;
}) {
  const [artifactText, setArtifactText] = useState("");
  const [challenge, setChallenge] = useState<PossessionChallenge | null>(null);
  const [holderSecret, setHolderSecret] = useState("");
  const [holderPrivKey, setHolderPrivKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VerifyResult | null>(null);
  // Nonces this verifier session has already consumed — a possession proof is single-use.
  const usedNonces = useMemo(() => new Set<string>(), []);

  const onIssueChallenge = useCallback(() => {
    setError(null);
    setResult(null);
    try {
      parseArtifactV2(artifactText); // reject a malformed artifact before issuing anything
      setChallenge({
        nonce: randomNonce(),
        expiry: Math.floor(Date.now() / 1000) + CHALLENGE_TTL_SECONDS,
        verifierId: VERIFIER_ID,
      });
    } catch (e) {
      setChallenge(null);
      setError((e as Error).message);
    }
  }, [artifactText]);

  const onVerify = useCallback(async () => {
    if (!props.chain || !props.circleV2 || !challenge) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const artifact = parseArtifactV2(artifactText);
      const holder = deriveMemberIdentity(
        "holder",
        parseFelt(holderSecret, "holder invite secret"),
        parseFelt(holderPrivKey, "holder auth private key"),
      );
      const possession: PossessionResponse = signPossessionV2(holder, artifact, challenge);
      const r = await verifyCredentialV2({
        artifact,
        possession,
        chain: props.chain,
        expectedCircleV2: props.circleV2,
        expectedNetwork: NETWORK,
        verifierId: VERIFIER_ID,
        claimNonce: (nonce) => {
          if (usedNonces.has(nonce)) return false;
          usedNonces.add(nonce);
          return true;
        },
        now: () => Math.floor(Date.now() / 1000),
      });
      setResult(r);
      setChallenge(null); // a challenge is single-use; force a fresh one for another attempt
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [props.chain, props.circleV2, challenge, artifactText, holderSecret, holderPrivKey, usedNonces]);

  const color =
    result?.status === "Verified" ? "#070" : result?.status === "Invalid" ? "#c00" : "#a40";

  return (
    <div style={box}>
      <h2 style={{ fontSize: 15 }}>Verify a credential</h2>
      <p style={{ fontSize: 12, color: "#777" }}>
        Paste the artifact, issue a one-time challenge, then have the holder answer it with the same
        key that signed the credential. The verifier reads IwaCircleV2 and re-derives every fact.
      </p>

      <label style={{ display: "block", margin: "6px 0", fontSize: 13 }}>
        Credential artifact JSON
        <textarea
          style={{ ...input, minHeight: 140 }}
          spellCheck={false}
          value={artifactText}
          onChange={(e) => setArtifactText(e.target.value)}
        />
      </label>

      <button
        style={{ padding: "6px 12px" }}
        disabled={busy || artifactText.trim() === ""}
        onClick={onIssueChallenge}
      >
        Issue possession challenge
      </button>

      {challenge && (
        <div style={{ ...box, background: "#f6f6f6" }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>Challenge issued</div>
          <div style={mono}>nonce: {challenge.nonce}</div>
          <div style={mono}>
            expires: {new Date(challenge.expiry * 1000).toLocaleTimeString()} · verifier:{" "}
            {challenge.verifierId}
          </div>
          <p style={{ fontSize: 12, color: "#777", marginTop: 8 }}>
            Holder answers below (session-only key; never stored or sent):
          </p>
          {(
            [
              ["Holder invite secret (0x…)", holderSecret, setHolderSecret],
              ["Holder auth private key (0x…)", holderPrivKey, setHolderPrivKey],
            ] as const
          ).map(([label, value, setter]) => (
            <label key={label} style={{ display: "block", margin: "6px 0", fontSize: 13 }}>
              {label}
              <input
                style={input}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={value}
                onChange={(e) => setter(e.target.value)}
              />
            </label>
          ))}
          <button style={btn} disabled={busy || !props.chain} onClick={() => void onVerify()}>
            {busy ? "verifying…" : "Answer challenge & verify"}
          </button>
        </div>
      )}

      {error && <div style={{ ...box, borderColor: "#c00", color: "#c00" }}>{error}</div>}

      {result && (
        <div style={{ ...box, borderColor: color }}>
          <div style={{ fontSize: 16, fontWeight: 700, color }}>{result.status}</div>
          {result.reason && <p style={{ fontSize: 13, color: "#555" }}>{result.reason}</p>}
          {result.status === "Verified" && result.claim && result.subject && (
            <div style={{ fontSize: 13, marginTop: 6 }}>
              <div>
                Claim: <strong>{result.claim.type}</strong>
                {result.claim.type === "good_standing"
                  ? ` — ${result.claim.thresholdRounds} qualifying rounds`
                  : ""}
              </div>
              <div style={mono}>circle {result.subject.circleId} · member {result.subject.memberRef}</div>
            </div>
          )}
          {result.status === "Unable to verify" && (
            <p style={{ fontSize: 12, color: "#a40" }}>
              The chain could not be read. This is never treated as valid — try again.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
