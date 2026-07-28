import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Inter (variable) — the one UI + display face (Design v2). Self-hosted via
// fontsource so the app doesn't depend on Google Fonts for its primary face.
import "@fontsource-variable/inter";
import "./index.css";
import "./lib/posthog";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
