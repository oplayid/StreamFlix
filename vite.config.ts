import { defineConfig, loadEnv, type UserConfig } from "vite";
import { nitro } from "nitro/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";

export default defineConfig(({ command, mode }): UserConfig => {
  const env = loadEnv(mode, process.cwd(), "");
  for (const key of [
    "NVIDIA_API_KEY",
    "NVIDIA_NIM_API_KEY",
    "NVIDIA_BASE_URL",
    "NVIDIA_MODEL",
    "TURNSTILE_SECRET_KEY",
    "MONGODB_URI",
    "MONGODB_DB",
    "POCKET_ID_ISSUER",
    "POCKET_ID_URL",
    "POCKET_ID_CLIENT_ID",
    "POCKET_ID_CLIENT_SECRET",
    "POCKET_ID_REDIRECT_URI",
    "APP_URL",
    "WEB_PUSH_PUBLIC_KEY",
    "VITE_WEB_PUSH_PUBLIC_KEY",
    "WEB_PUSH_PRIVATE_KEY",
    "WEB_PUSH_SUBJECT",
    "CRON_SECRET",
    "WAYBACK_ARCHIVE_KEY",
  ]) {
    if (env[key] && !process.env[key]) process.env[key] = env[key];
  }
  return {
    css: { transformer: "lightningcss" },
    resolve: {
      alias: { "@": `${process.cwd()}/src` },
      dedupe: [
        "react",
        "react-dom",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "@tanstack/react-query",
        "@tanstack/query-core",
      ],
    },
    optimizeDeps: {
      include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"],
      ignoreOutdatedRequests: true,
    },
    plugins: [
      tailwindcss(),
      tsConfigPaths({ projects: ["./tsconfig.json"] }),
      tanstackStart({
        importProtection: {
          behavior: "error",
          client: { files: ["**/server/**"], specifiers: ["server-only"] },
        },
        server: { entry: "server" },
      }),
      ...(command === "build" ? [nitro({ preset: "node-server" })] : []),
      react(),
    ],
    build: {
      rollupOptions: {
        external: ["@capacitor/push-notifications"],
        output: {
          manualChunks(id) {
            if (id.includes("node_modules/recharts")) {
              return "vendor-recharts";
            }
            if (id.includes("node_modules/@radix-ui/")) {
              return "vendor-radix";
            }
          },
        },
      },
    },
    server: {
      host: "::",
      port: 8080,
      watch: {
        awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 },
      },
    },
  };
});
