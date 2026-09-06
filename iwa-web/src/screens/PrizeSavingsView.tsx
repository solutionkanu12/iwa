// screens/PrizeSavingsView.tsx — Iwa Prize Savings, inside the Iwa shell.
//
// One product surface: the same shell, the same lavender system, the same
// language. Confidential deposits into a shared pool, a verifiable draw, and
// principal that stays yours.
//
// Rules this screen follows:
//  - it never logs a ciphertext, a proof, or a decrypted balance
//  - a decrypted balance is rendered and then discarded
//  - every action is an explicit button press; nothing signs by itself
//  - the Ethereum connection comes from the shared Iwa-level wallet manager,
//    independent of the Starknet wallet of the rest of Iwa, and nothing here
//    touches the Starknet session

import { useCallback, useEffect, useState } from "react";

import { Island } from "../components/Island.tsx";
import { Button } from "../components/Button.tsx";
import { useWallet } from "../app/WalletProvider.tsx";
import { IWA_PRIZE_SAVINGS } from "../chains/ethereum/config";
import {
  creditedHandleOf,
  isOperator,
  isPoolOwner,
  mintMockUSD,
  readPool,
  readUserState,
  sendPoolNoArg,
  sendPoolOwnerNoArg,
  sendPoolOwnerTx,
  sendPoolTx,
  setOperator,
  wrapMockUSD,
  ZERO_HANDLE,
} from "../features/prizeSavings/contracts.ts";
import { encryptUint64, userDecryptUint64 } from "../features/prizeSavings/zama.ts";
import {
  claimOffer,
  depositOffer,
  formatUnits6,
  ownerOffer,
  parseUnits6,
  PRIZE_SAVINGS_COPY as C,
  stageOf,
  type PoolFacts,
} from "../lib/prizeSavings/flow.ts";
import { evmGate } from "../lib/prizeSavings/gate.ts";
import styles from "./PrizeSavingsView.module.css";

const MOCK_USD_UNITS = 1000_000_000n; // 1000.000000 test units

export function PrizeSavingsView() {
  const walletManager = useWallet();
  const wallet = walletManager.evm.status;
  const account = walletManager.evm.address;
  const [facts, setFacts] = useState<PoolFacts | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [depositInput, setDepositInput] = useState("");
  const [withdrawInput, setWithdrawInput] = useState("");
  const [fundInput, setFundInput] = useState("");
  const [mockBalance, setMockBalance] = useState<string | null>(null);
  const [wrappedBalance, setWrappedBalance] = useState<string | null>(null);

  const stage = stageOf({
    wallet,
    onSepolia: wallet === "connected",
    facts,
    loadFailed,
  });

  const refresh = useCallback(async () => {
    if (wallet !== "connected" || account === null) return;
    try {
      const pool = await readPool();
      const user = await readUserState(account);
      const operator = await isOperator(account);
      const owner = await isPoolOwner(account);
      setFacts({
        roundState: pool.roundState,
        participantCount: pool.participantCount,
        maxParticipants: pool.maxParticipants,
        isParticipant: user.isParticipant,
        hasClaimed: user.hasClaimed,
        isOwner: owner,
        operatorGranted: operator,
      });
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [wallet, account]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = useCallback(async () => {
    setError(null);
    setBusy("connect");
    try {
      await walletManager.connectEthereum();
    } catch {
      setError("Could not connect the wallet. You can decline and try again.");
    } finally {
      setBusy(null);
    }
  }, [walletManager]);

  const switchNetwork = useCallback(async () => {
    setError(null);
    setBusy("network");
    try {
      await walletManager.switchToSepolia();
    } catch {
      setError("Sepolia is needed for Iwa Prize Savings.");
    } finally {
      setBusy(null);
    }
  }, [walletManager]);

  const run = useCallback(
    async (name: string, action: () => Promise<unknown>, after?: () => Promise<void>) => {
      setError(null);
      setBusy(name);
      try {
        await action();
        if (after !== undefined) await after();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // Wallet rejection / cancel is not an error the app should dress up.
        setError(
          /user rejected|declined|denied/i.test(message)
            ? "Transaction declined. Nothing was changed."
            : "That did not go through. Nothing was changed.",
        );
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const getTokens = useCallback(async () => {
    if (account === null) return;
    await run("tokens", async () => {
      await mintMockUSD(account, MOCK_USD_UNITS);
      setMockBalance(formatUnits6(MOCK_USD_UNITS));
    });
  }, [account, run]);

  const wrap = useCallback(async () => {
    if (account === null) return;
    await run("wrap", async () => {
      await wrapMockUSD(account, MOCK_USD_UNITS);
      setWrappedBalance(formatUnits6(MOCK_USD_UNITS));
    }, refresh);
  }, [account, run, refresh]);

  const grantOperator = useCallback(async () => {
    if (account === null) return;
    await run("operator", async () => {
      await setOperator(Math.floor(Date.now() / 1000) + 60 * 60);
    }, refresh);
  }, [account, run, refresh]);

  const deposit = useCallback(async () => {
    if (account === null) return;
    const amount = parseUnits6(depositInput);
    if (amount === null || amount <= 0n) {
      setError("Enter a valid amount, up to six decimal places.");
      return;
    }
    await run(
      "deposit",
      async () => {
        const encrypted = await encryptUint64(
          IWA_PRIZE_SAVINGS.IwaPrizeSavings,
          account,
          amount,
        );
        await sendPoolTx("deposit", encrypted.handle, encrypted.inputProof);
      },
      async () => {
        await refresh();
        setDepositInput("");
        setBalance(null);
      },
    );
  }, [account, depositInput, run, refresh]);

  const withdraw = useCallback(async () => {
    if (account === null) return;
    const amount = parseUnits6(withdrawInput);
    if (amount === null || amount <= 0n) {
      setError("Enter a valid amount, up to six decimal places.");
      return;
    }
    await run(
      "withdraw",
      async () => {
        const encrypted = await encryptUint64(IWA_PRIZE_SAVINGS.IwaPrizeSavings, account, amount);
        await sendPoolTx("withdraw", encrypted.handle, encrypted.inputProof);
      },
      async () => {
        await refresh();
        setWithdrawInput("");
        setBalance(null);
      },
    );
  }, [account, withdrawInput, run, refresh]);

  const withdrawAll = useCallback(async () => {
    await run("withdrawAll", () => sendPoolNoArg("withdrawAll"), async () => {
      await refresh();
      setBalance(null);
    });
  }, [run, refresh]);

  const revealBalance = useCallback(async () => {
    if (account === null) return;
    setError(null);
    setBusy("decrypt");
    try {
      const handle = await creditedHandleOf(account);
      if (handle === ZERO_HANDLE) {
        setBalance("0");
        return;
      }
      const value = await userDecryptUint64(IWA_PRIZE_SAVINGS.IwaPrizeSavings, account, handle);
      // Rendered, then discarded. Never logged.
      setBalance(formatUnits6(value));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(
        /rejected|declined|denied/i.test(message)
          ? "Decryption declined. Your balance stays private."
          : "Could not decrypt right now. The relayer may be busy; try again.",
      );
    } finally {
      setBusy(null);
    }
  }, [account, run]);

  const fundPrize = useCallback(async () => {
    if (account === null) return;
    const amount = parseUnits6(fundInput);
    if (amount === null || amount <= 0n) {
      setError("Enter a valid amount, up to six decimal places.");
      return;
    }
    await run(
      "fund",
      async () => {
        const encrypted = await encryptUint64(IWA_PRIZE_SAVINGS.IwaPrizeSavings, account, amount);
        await sendPoolOwnerTx("fundPrize", encrypted.handle, encrypted.inputProof);
      },
      async () => {
        await refresh();
        setFundInput("");
      },
    );
  }, [account, fundInput, run, refresh]);

  const lockRound = useCallback(
    () => run("lock", () => sendPoolOwnerNoArg("lockRound"), refresh),
    [run, refresh],
  );

  const draw = useCallback(
    () => run("draw", () => sendPoolOwnerNoArg("draw"), refresh),
    [run, refresh],
  );

  const claim = useCallback(
    () => run("claim", () => sendPoolNoArg("claim"), refresh),
    [run, refresh],
  );

  const depositView = depositOffer(stage);
  const claimView = claimOffer(facts);
  const ownerView = ownerOffer(facts);
  const gate = evmGate(walletManager.evm);

  return (
    <>
      <Island className={styles.card}>
        <p className={styles.eyebrow}>{C.eyebrow}</p>
        <h2 className={styles.h2}>{C.heading}</h2>
        <p className={styles.meta}>{C.intro}</p>
        <p className={styles.meta}>{C.privacyNote}</p>

        {gate.kind === "connectEvm" ? (
          <div className={styles.stack}>
            <p className={styles.meta}>{C.gateEvm}</p>
            <p className={styles.meta}>{C.gateEvmNote}</p>
            <Button onClick={() => void connect()} disabled={busy !== null}>
              {C.gateEvmAction}
            </Button>
          </div>
        ) : null}

        {gate.kind === "switchSepolia" ? (
          <div className={styles.stack}>
            <p className={styles.meta}>{C.gateSepolia}</p>
            <Button onClick={() => void switchNetwork()} disabled={busy !== null}>
              {C.gateSepoliaAction}
            </Button>
          </div>
        ) : null}

        {stage === "load" ? <p className={styles.meta}>Reading the pool…</p> : null}

        {stage === "loadFailed" ? (
          <div className={styles.stack}>
            <p className={styles.meta}>The pool could not be read right now.</p>
            <Button variant="ghost" onClick={() => void refresh()} disabled={busy !== null}>
              Try again
            </Button>
          </div>
        ) : null}

        {error !== null ? <p className={styles.error}>{error}</p> : null}
      </Island>

      {gate.kind === "ready" &&
      (stage === "open" || stage === "locked" || stage === "drawn" || stage === "claimable") ? (
        <>
          <Island className={styles.card}>
            <h2 className={styles.h2}>Your side</h2>
            <p className={styles.meta}>
              {facts !== null
                ? `${facts.participantCount} of ${facts.maxParticipants} places taken. `
                : ""}
              {stage === "open"
                ? C.roundOpen
                : stage === "locked"
                  ? C.locked
                  : stage === "drawn"
                    ? C.drawn
                    : C.claimable}
            </p>

            {mockBalance === null ? (
              <div className={styles.action}>
                <h3 className={styles.actionTitle}>{C.getTokensTitle}</h3>
                <p className={styles.actionDetail}>{C.getTokensDetail}</p>
                <Button className={styles.button} variant="ghost" onClick={() => void getTokens()} disabled={busy !== null}>
                  {C.getTokens}
                </Button>
              </div>
            ) : (
              <p className={styles.meta}>MockUSD on hand: {mockBalance}</p>
            )}

            {wrappedBalance === null ? (
              <div className={styles.action}>
                <h3 className={styles.actionTitle}>{C.wrapTitle}</h3>
                <p className={styles.actionDetail}>{C.wrapDetail}</p>
                <Button className={styles.button} variant="ghost" onClick={() => void wrap()} disabled={busy !== null}>
                  {C.wrap}
                </Button>
              </div>
            ) : (
              <p className={styles.meta}>Wrapped cMockUSD on hand: {wrappedBalance}</p>
            )}

            {facts?.operatorGranted !== true ? (
              <div className={styles.action}>
                <h3 className={styles.actionTitle}>{C.grantOperatorTitle}</h3>
                <p className={styles.actionDetail}>{C.grantOperatorDetail}</p>
                <Button className={styles.button} variant="ghost" onClick={() => void grantOperator()} disabled={busy !== null}>
                  {C.grantOperator}
                </Button>
              </div>
            ) : (
              <p className={styles.meta}>Pool operator permission granted.</p>
            )}

            {depositView.canDeposit ? (
              <div className={styles.inputRow}>
                <input
                  className={styles.input}
                  inputMode="decimal"
                  placeholder="Amount to deposit"
                  value={depositInput}
                  onChange={(e) => setDepositInput(e.target.value)}
                />
                <Button className={styles.button} onClick={() => void deposit()} disabled={busy !== null}>
                  {C.deposit}
                </Button>
              </div>
            ) : null}
            {depositView.reason !== null ? <p className={styles.meta}>{depositView.reason}</p> : null}

            <div className={styles.inputRow}>
              <input
                className={styles.input}
                inputMode="decimal"
                placeholder="Amount to withdraw"
                value={withdrawInput}
                onChange={(e) => setWithdrawInput(e.target.value)}
              />
              <Button
                className={styles.button}
                variant="ghost"
                onClick={() => void withdraw()}
                disabled={busy !== null || !depositView.canWithdraw}
              >
                {C.withdraw}
              </Button>
            </div>
            <div className={styles.stack}>
              <Button
                variant="ghost"
                onClick={() => void withdrawAll()}
                disabled={busy !== null || !depositView.canWithdraw}
              >
                {C.withdrawAll}
              </Button>
            </div>
          </Island>

          <Island className={styles.card}>
            <h2 className={styles.h2}>{C.balance}</h2>
            <p className={styles.meta}>{C.balanceDetail}</p>
            <div className={styles.stack}>
              <Button variant="ghost" onClick={() => void revealBalance()} disabled={busy !== null}>
                {balance === null ? "Reveal my balance" : "Reveal again"}
              </Button>
            </div>
            {balance !== null ? <p className={styles.bignum}>{balance}</p> : null}
          </Island>

          {ownerView.isOwner ? (
            <Island className={styles.card}>
              <h2 className={styles.h2}>Round host</h2>
              <p className={styles.meta}>{C.ownerOnly}</p>
              {ownerView.canFund ? (
                <div className={styles.inputRow}>
                  <input
                    className={styles.input}
                    inputMode="decimal"
                    placeholder="Reward amount"
                    value={fundInput}
                    onChange={(e) => setFundInput(e.target.value)}
                  />
                  <Button className={styles.button} variant="ghost" onClick={() => void fundPrize()} disabled={busy !== null}>
                    {C.fundPrize}
                  </Button>
                </div>
              ) : null}
              {ownerView.canLock ? (
                <div className={styles.stack}>
                  <Button onClick={() => void lockRound()} disabled={busy !== null}>
                    {C.lockRound}
                  </Button>
                </div>
              ) : null}
              {ownerView.canDraw ? (
                <div className={styles.stack}>
                  <Button onClick={() => void draw()} disabled={busy !== null}>
                    {C.draw}
                  </Button>
                </div>
              ) : null}
            </Island>
          ) : null}

          {claimView.canClaim || claimView.reason !== null ? (
            <Island className={styles.card}>
              <h2 className={styles.h2}>This round's draw</h2>
              {claimView.reason !== null ? <p className={styles.meta}>{claimView.reason}</p> : null}
              {claimView.canClaim ? (
                <div className={styles.stack}>
                  <Button onClick={() => void claim()} disabled={busy !== null}>
                    {claimView.claimLabel}
                  </Button>
                </div>
              ) : null}
              <p className={styles.meta}>
                A round without a winner rolls the reward over untouched - everyone simply keeps
                their principal.
              </p>
            </Island>
          ) : null}

          <p className={styles.tech}>{C.techNote}</p>
        </>
      ) : null}
    </>
  );
}
