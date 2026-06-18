import { contextBridge, ipcRenderer } from "electron";

export interface DesktopUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  org: { id: string; name: string };
}

export interface DesktopSession {
  user: DesktopUser;
  apiBaseUrl: string;
  wsBaseUrl: string;
}

const api = {
  async getConfig(): Promise<{ apiBaseUrl: string; wsBaseUrl: string }> {
    return ipcRenderer.invoke("config:get");
  },
  auth: {
    me(): Promise<DesktopSession | null> {
      return ipcRenderer.invoke("auth:me");
    },
    signIn(email: string, password: string): Promise<{ user: DesktopUser; session: DesktopSession }> {
      return ipcRenderer.invoke("auth:signIn", email, password);
    },
    signOut(): Promise<{ ok: true }> {
      return ipcRenderer.invoke("auth:signOut");
    },
    getAccessToken(): Promise<string | null> {
      return ipcRenderer.invoke("auth:getAccessToken");
    },
  },
};

contextBridge.exposeInMainWorld("j2w", api);

declare global {
  interface Window {
    j2w: typeof api;
  }
}

export type J2WBridge = typeof api;
