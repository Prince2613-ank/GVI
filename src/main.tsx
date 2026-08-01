import ReactDOM from "react-dom/client";
import App from "./App";
import { AutomationHarness, parseAutomationParams } from "./features/balcony-debug/AutomationHarness";

// Note: StrictMode is intentionally omitted. Its dev-mode double-invoked
// effects would create/destroy the Cesium Viewer's WebGL context twice in
// rapid succession, which Cesium does not handle cleanly.

// ?automation=1&floor=&direction=&flat= renders ONLY the bare Cesium canvas
// (no App UI at all) — the production balcony-generation worker drives this
// via Puppeteer, so there is never any panel/button/sidebar in the frame it
// screenshots. A normal browser visit (no automation params) renders the
// full interactive App exactly as before.
const automationParams = parseAutomationParams(window.location.search);

ReactDOM.createRoot(document.getElementById("root")!).render(
  automationParams ? <AutomationHarness {...automationParams} /> : <App />
);
