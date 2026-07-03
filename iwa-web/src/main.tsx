import "./lib/polyfills.ts";
import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles/global.css";
import { App } from "./App.tsx";
import { LandingPage } from "./landing/LandingPage.tsx";
import { connectWallet, WalletCancelledError } from "./lib/wallet.ts";

// The single entry for both the marketing landing page and the app (Circle /
// Browse / My standing), so a wallet connected on landing carries straight
// into the app with no second connect step: same JS module, same
// StellarWalletsKit instance, same connectWallet() from lib/wallet.ts.
//
// "/" shows the landing page. "/app" shows the app; if the visitor lands there
// directly (no prior connect), the app's own connect gate takes over exactly
// as before. Litepaper and roadmap remain separate, untouched entries.
function AppRoot() {
  const [view, setView] = useState<"landing" | "app">(() =>
    window.location.pathname.startsWith("/app") ? "app" : "landing",
  );
  const [address, setAddress] = useState<string | null>(null);

  const onEnterCircle = useCallback(async () => {
    try {
      const addr = await connectWallet();
      setAddress(addr);
      setView("app");
      window.history.pushState(null, "", "/app");
    } catch (err) {
      // A cancelled modal or declined connection: stay on the landing page,
      // no broken state.
      if (!(err instanceof WalletCancelledError)) {
        console.warn("wallet connect failed", err);
      }
    }
  }, []);

  if (view === "app") return <App address={address} />;
  return <LandingPage onEnterCircle={onEnterCircle} />;
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("root element not found");

createRoot(rootEl).render(
  <StrictMode>
    <AppRoot />
  </StrictMode>,
);
