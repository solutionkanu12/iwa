import "./lib/polyfills.ts";
import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles/global.css";
import { App } from "./App.tsx";
import { LandingPage } from "./landing/LandingPage.tsx";
import { Strk20ConsoleView } from "./screens/Strk20ConsoleView.tsx";
import { OrganizerCircleView } from "./screens/OrganizerCircleView.tsx";
import { AcceptInviteView } from "./screens/AcceptInviteView.tsx";
import { connectWallet, WalletCancelledError } from "./lib/starknetWallet.ts";

// The single entry for both the marketing landing page and the app (Circle /
// Browse / My standing), so a wallet connected on landing carries straight
// into the app with no second connect step: same JS module, same
// wallet connection, same connectWallet() from lib/starknetWallet.ts.
//
// "/" shows the landing page. "/app" shows the app; if the visitor lands there
// directly (no prior connect), the app's own connect gate takes over exactly
// as before. Litepaper and roadmap remain separate, untouched entries.
function AppRoot() {
  const [view, setView] = useState<"landing" | "app" | "strk20" | "start" | "invite">(() => {
    const path = window.location.pathname;
    if (path.startsWith("/strk20")) return "strk20";
    if (path.startsWith("/start")) return "start";
    if (path.startsWith("/invite/")) return "invite";
    return path.startsWith("/app") ? "app" : "landing";
  });
  // The invitation token is the rest of the path. It is a coordination
  // pointer, never a credential: a member's identity comes from their wallet.
  const inviteToken = window.location.pathname.startsWith("/invite/")
    ? decodeURIComponent(window.location.pathname.slice("/invite/".length))
    : "";
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

  // Operator console for the STRK20 mainnet run. Deliberately a separate
  // route: it does not touch the existing landing or app UI.
  if (view === "strk20") return <Strk20ConsoleView />;
  if (view === "start") return <OrganizerCircleView />;
  if (view === "invite") return <AcceptInviteView token={inviteToken} />;
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
