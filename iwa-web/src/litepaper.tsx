import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/global.css";
import { LitepaperPage } from "./litepaper/LitepaperPage.tsx";

// Entry for the standalone litepaper page. Separate from the app entry
// (main.tsx) and the landing entry (landing.tsx), which are left untouched.
const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("root element not found");

createRoot(rootEl).render(
  <StrictMode>
    <LitepaperPage />
  </StrictMode>,
);
