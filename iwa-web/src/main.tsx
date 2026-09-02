import "./lib/polyfills.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/global.css";
import { App } from "./App.tsx";
import { LandingPage } from "./landing/LandingPage.tsx";
import { Strk20ConsoleView } from "./screens/Strk20ConsoleView.tsx";
import { AcceptInviteView } from "./screens/AcceptInviteView.tsx";
import { WalletProvider } from "./app/WalletProvider.tsx";
import { SessionProvider } from "./app/SessionProvider.tsx";
import { useRoute } from "./lib/router.ts";

// The single entry for the marketing landing page and the application alike,
// so a wallet connected in one carries into the other with no second prompt.
//
// Three things live outside the application shell, each for its own reason. The
// landing page has its own navigation and its own design. An invitation is an
// external entry point, opened by people who may never have seen Iwa. And the
// operator console is internal tooling.
//
// The operator console shows class hashes, funding figures and dry-build
// internals. It sends nothing without a wallet and holds no secrets, but it is
// not something a visitor should land on: on in development, and in production
// only when explicitly switched on. Because the flag resolves at build time, a
// default production build drops the console entirely rather than hiding it.
const OPERATOR_CONSOLE_ENABLED =
  import.meta.env.DEV || import.meta.env.VITE_ENABLE_OPERATOR_CONSOLE === "true";

function AppRoot() {
  const { route, navigate } = useRoute();

  if (route.name === "landing") {
    return <LandingPage onEnterCircle={() => navigate({ name: "home" })} />;
  }
  if (route.name === "invite") {
    return <AcceptInviteView token={route.token} navigate={navigate} />;
  }
  if (route.name === "console") {
    // A disabled console is not a route: it falls through to the application
    // rather than rendering a shell around nothing.
    if (OPERATOR_CONSOLE_ENABLED) return <Strk20ConsoleView />;
    return <App route={{ name: "notFound", path: "/strk20" }} navigate={navigate} />;
  }
  return <App route={route} navigate={navigate} />;
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("root element not found");

createRoot(rootEl).render(
  <StrictMode>
    <WalletProvider>
      <SessionProvider>
        <AppRoot />
      </SessionProvider>
    </WalletProvider>
  </StrictMode>,
);
