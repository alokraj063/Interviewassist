// Use CommonJS require for electron bindings — the Vite ESM→CJS conversion
// emits namespace access that breaks on Node 20 when interop is ambiguous.
 
import path from "node:path";

// `require` is defined by Node at runtime when this file is loaded as CJS —
// electron-vite builds main as `format: "cjs"`, so this works.
declare const require: NodeRequire;

const electron: typeof import("electron") = require("electron");
const { app, BrowserWindow, desktopCapturer, ipcMain, session, systemPreferences } = electron;
import { getAccessToken, initAuth, signIn, signOut, whoAmI } from "./auth.js";
import { apiBaseUrl, wsBaseUrl } from "./config.js";

let mainWindow: Electron.BrowserWindow | null = null;

async function createWindow() {
  if (process.platform === "darwin") {
    try {
      const micStatus = systemPreferences.getMediaAccessStatus("microphone");
      if (micStatus !== "granted") {
        await systemPreferences.askForMediaAccess("microphone");
      }
    } catch {
      // system-permissions may throw in some sandboxed builds — continue
    }
  }

  mainWindow = new BrowserWindow({
    width: 440,
    height: 560,
    resizable: false,
    minimizable: true,
    maximizable: false,
    title: "J2W Audio Companion",
    backgroundColor: "#0a0a0a",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => {
    if (perm === "media" || perm === "display-capture") {
      cb(true);
      return;
    }
    cb(false);
  });
  // Renderer calls getDisplayMedia({audio: true, video: true}) because macOS
  // won't surface loopback audio without a video request. The video track is
  // stopped immediately; Electron still requires us to name a source here.
  session.defaultSession.setDisplayMediaRequestHandler(async (req, cb) => {
    if (req.videoRequested) {
      const sources = await desktopCapturer.getSources({ types: ["screen"] });
      if (sources[0]) {
        cb({ video: sources[0], audio: "loopback" });
        return;
      }
    }
    cb({ audio: "loopback" });
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    await mainWindow.loadURL(rendererUrl);
  } else {
    await mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  if (process.env.J2W_DEVTOOLS === "1") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

app.whenReady().then(async () => {
  await initAuth();
  await createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

ipcMain.handle("config:get", () => ({
  apiBaseUrl: apiBaseUrl(),
  wsBaseUrl: wsBaseUrl(),
}));

ipcMain.handle("auth:me", () => whoAmI());
ipcMain.handle("auth:signIn", async (_e, email: string, password: string) => {
  const res = await signIn(email, password);
  return { ...res, session: whoAmI() };
});
ipcMain.handle("auth:signOut", async () => {
  await signOut();
  return { ok: true };
});
ipcMain.handle("auth:getAccessToken", async () => {
  try {
    return await getAccessToken();
  } catch {
    return null;
  }
});
