import "./lib/polyfills.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/global.css";
import { LandingPage } from "./landing/LandingPage";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("root element not found");

createRoot(rootEl).render(
  <StrictMode>
    <LandingPage />
  </StrictMode>,
);
