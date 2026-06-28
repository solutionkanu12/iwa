import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/global.css";
import { LandingPage } from "./landing/LandingPage.tsx";

// Entry for the public marketing landing page. Separate from the app entry
// (main.tsx / App.tsx), which is left untouched.
const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("root element not found");

createRoot(rootEl).render(
  <StrictMode>
    <LandingPage />
  </StrictMode>,
);
