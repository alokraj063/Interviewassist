import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  envDir: path.resolve(__dirname, ".."),
  // Production is served under the /ai-interview-agent/ subpath on the mrr domain
  // (Caddy routes the prefix to this app; api/ws are proxied with the prefix
  // stripped). Dev stays at root so localhost:8084 works unchanged.
  base: mode === "production" ? "/ai-interview-agent/" : "/",
  server: {
    host: "::",
    port: Number(process.env.WEB_PORT) || 8084,
    strictPort: true,
    hmr: {
      overlay: false,
    },
  },
  // `vite preview` serves the production build behind Caddy; the proxied Host
  // header is the public domain, so allow it through preview's host check.
  preview: {
    host: "0.0.0.0",
    port: Number(process.env.WEB_PORT) || 8084,
    strictPort: true,
    allowedHosts: true,
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "@tanstack/react-query", "@tanstack/query-core"],
  },
}));
