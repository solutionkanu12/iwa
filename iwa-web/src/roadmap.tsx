import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/global.css";
import { RoadmapPage } from "./roadmap/RoadmapPage.tsx";

// Entry for the standalone roadmap page. Separate from the app (main.tsx),
// landing (landing.tsx), and litepaper (litepaper.tsx) entries, all untouched.
const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("root element not found");

createRoot(rootEl).render(
  <StrictMode>
    <RoadmapPage />
  </StrictMode>,
);
