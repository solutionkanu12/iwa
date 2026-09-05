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
//  - the Ethereum wallet is separate from the Starknet wallet of the rest
//    of Iwa, and nothing here touches the Starknet session

import { useCallback, useEffect, useState } from "react";

import { Island } from "../components/Island.tsx";
import { Button } from "../components/Button.tsx";
import { connectEthereumWallet, getEthereumProvider, readChainId, switchToSepolia } from "../chains/ethereum/wallet";
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
import styles from "./PrizeSavingsView.module.css";

const MOCK_USD_UNITS = 1000_000_000n; // 1000.000000 test units

export function PrizeSavingsView() {
  const [wallet, setWallet] = useState<"missing" | "disconnected" | "wrongNetwork" | "connected">(
    "disconnected",
  );
  const [account, setAccount] = useState<string | null>(null);
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
      const result = await connectEthereumWallet();
      setWallet(result);
      if (result === "connected") {
        const provider = getEthereumProvider();
        if (provider === null) throw new Error("No Ethereum wallet found");
        const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
        setAccount(accounts[0]);
      }
    } catch (e) {
      setWallet("disconnected");
      setError("Could not connect the wallet. You can decline and try again.");
    } finally {
      setBusy(null);
    }
  }, []);

  const switchNetwork = useCallback(async () => {
    setError(null);
    setBusy("network");
    try {
      const provider = getEthereumProvider();
      if (provider === null) throw new Error("No Ethereum wallet found");
      await switchToSepolia(provider);
      const chainId = await readChainId(provider);
      if (chainId === 11155111n) {
        setWallet("connected");
        const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
        setAccount(accounts[0]);
      }
    } catch {
      setError("Sepolia is needed for Iwa Prize Savings.");
    } finally {
      setBusy(null);
    }
  }, []);

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

  return (
    <>
      <Island className={styles.card}>
        <p className={styles.eyebrow}>{C.eyebrow}</p>
        <h2 className={styles.h2}>{C.heading}</h2>
        <p className={styles.meta}>{C.intro}</p>
        <p className={styles.meta}>{C.privacyNote}</p>

        {stage === "walletMissing" ? (
          <p className={styles.meta}>{C.connect}</p>
        ) : null}

        {stage === "connect" ? (
          <div className={styles.stack}>
            <Button onClick={() => void connect()} disabled={busy !== null}>
              {C.connect}
            </Button>
          </div>
        ) : null}

        {stage === "wrongNetwork" ? (
          <div className={styles.stack}>
            <p className={styles.meta}>{C.wrongNetwork}</p>
            <Button onClick={() => void switchNetwork()} disabled={busy !== null}>
              Switch to Sepolia
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

      {stage === "open" || stage === "locked" || stage === "drawn" || stage === "claimable" ? (
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
              <div className={styles.row}>
                <div>
                  <p className={styles.meta}>{C.getTokensDetail}</p>
                </div>
                <Button variant="ghost" onClick={() => void getTokens()} disabled={busy !== null}>
                  {C.getTokens}
                </Button>
              </div>
            ) : (
              <p className={styles.meta}>MockUSD on hand: {mockBalance}</p>
            )}

            {wrappedBalance === null ? (
              <div className={styles.row}>
                <div>
                  <p className={styles.meta}>{C.wrapDetail}</p>
                </div>
                <Button variant="ghost" onClick={() => void wrap()} disabled={busy !== null}>
                  {C.wrap}
                </Button>
              </div>
            ) : (
              <p className={styles.meta}>Wrapped cMockUSD on hand: {wrappedBalance}</p>
            )}

            {facts?.operatorGranted !== true ? (
              <div className={styles.row}>
                <div>
                  <p className={styles.meta}>{C.grantOperatorDetail}</p>
                </div>
                <Button variant="ghost" onClick={() => void grantOperator()} disabled={busy !== null}>
                  {C.grantOperator}
                </Button>
              </div>
            ) : (
              <p className={styles.meta}>Pool operator permission granted.</p>
            )}

            {depositView.canDeposit ? (
              <div className={styles.row}>
                <input
                  className={styles.input}
                  inputMode="decimal"
                  placeholder="Amount to deposit"
                  value={depositInput}
                  onChange={(e) => setDepositInput(e.target.value)}
                />
                <Button onClick={() => void deposit()} disabled={busy !== null}>
                  {C.deposit}
                </Button>
              </div>
            ) : null}
            {depositView.reason !== null ? <p className={styles.meta}>{depositView.reason}</p> : null}

            <div className={styles.row}>
              <input
                className={styles.input}
                inputMode="decimal"
                placeholder="Amount to withdraw"
                value={withdrawInput}
                onChange={(e) => setWithdrawInput(e.target.value)}
              />
              <Button
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
                <div className={styles.row}>
                  <input
                    className={styles.input}
                    inputMode="decimal"
                    placeholder="Reward amount"
                    value={fundInput}
                    onChange={(e) => setFundInput(e.target.value)}
                  />
                  <Button variant="ghost" onClick={() => void fundPrize()} disabled={busy !== null}>
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