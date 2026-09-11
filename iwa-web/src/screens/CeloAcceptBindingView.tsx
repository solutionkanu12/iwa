// Celo account-binding invite flow: connect the wallet this invite names,
// and it becomes the one Iwa recognises for that circle member from then on.
//
// There is nothing to preview before accepting: the invite token names a
// circle and member the visitor cannot see details of ahead of time, the
// same privacy shape the binding-status read uses (verify, never disclose).

import { useCallback, useState } from "react";

import styles from "./CircleSetup.module.css";
import { Button } from "../components/Button";
import { BackendError } from "../lib/backend";
import { acceptAccountBindingInvite } from "../chains/celo/accountBindingsApi";
import { EXPECTED_CELO_CHAIN_ID } from "../chains/celo/wallet";
import { getEthereumProvider, readChainId, requestAccount } from "../chains/ethereum/wallet";
import { normalizeAddress } from "../chains/celo/erc20";

function humanError(e: unknown): string {
  if (e instanceof BackendError) return e.message;
  if (e instanceof Error) return e.message;
  return "Something went wrong. Please try again.";
}

export function CeloAcceptBindingView({ token }: { token: string }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [linkedAddress, setLinkedAddress] = useState<string | null>(null);

  const onLink = useCallback(async () => {
    setError(null);
    setBusy("Connecting your wallet");
    try {
      const provider = getEthereumProvider();
      if (provider === null) throw new Error("No wallet found in this browser");
      const account = await requestAccount(provider);
      const chainId = await readChainId(provider);
      if (chainId !== EXPECTED_CELO_CHAIN_ID) {
        throw new Error("Please switch your wallet to Celo mainnet and try again.");
      }
      const address = normalizeAddress(account);
      setBusy("Linking your wallet");
      await acceptAccountBindingInvite({ inviteToken: token, account: `celo:${address}` });
      setLinkedAddress(address);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(null);
    }
  }, [token]);

  if (linkedAddress !== null) {
    return (
      <div className={styles.wrap}>
        <h1 className={styles.title}>Your wallet is linked</h1>
        <p className={styles.lede}>
          Iwa will recognise this wallet for your place in the circle from now on. Nothing more
          is needed from you here.
        </p>
        <div className={styles.success}>Wallet linked.</div>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>Link your wallet</h1>
      <p className={styles.lede}>
        The organizer has invited you to link a wallet to your place in a savings circle on
        Celo. Connect the wallet you want Iwa to recognise as yours.
      </p>

      {error && <div className={styles.notice}>{error}</div>}

      <div className={styles.actions}>
        <Button onClick={() => void onLink()} disabled={busy !== null}>
          Connect and link wallet
        </Button>
      </div>
      {busy && <p className={styles.busy}>{busy}…</p>}
      <p className={styles.hint}>
        Use the wallet you will contribute from. This link can only be used once, and it cannot
        reassign a wallet that is already linked.
      </p>
    </div>
  );
}
