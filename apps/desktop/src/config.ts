// Single source of truth for the desktop app's backend URLs.
//
// Resolution order (first match wins):
//   1. J2W_API_BASE_URL / J2W_WS_BASE_URL env vars — always win if set.
//   2. Packaged build → production deployment.
//   3. Dev build → localhost.

 
declare const require: NodeRequire;
const electron: typeof import("electron") = require("electron");
const { app } = electron;

const PROD_API_BASE_URL = "https://recruitassist.joulestowatts.online";
const PROD_WS_BASE_URL = "wss://recruitassist.joulestowatts.online";
const DEV_API_BASE_URL = "http://localhost:8787";
const DEV_WS_BASE_URL = "ws://localhost:8787";

export function apiBaseUrl(): string {
  const override = process.env.J2W_API_BASE_URL;
  if (override) return override;
  return app.isPackaged ? PROD_API_BASE_URL : DEV_API_BASE_URL;
}

export function wsBaseUrl(): string {
  const override = process.env.J2W_WS_BASE_URL;
  if (override) return override;
  return app.isPackaged ? PROD_WS_BASE_URL : DEV_WS_BASE_URL;
}
