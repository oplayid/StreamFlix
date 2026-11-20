import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/auth/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");
        const { redirectTo } = await import("@/lib/auth");
        if (error || !code || !state) {
          return redirectTo("/auth?error=oidc-denied", 302);
        }
        try {
          const { completeLogin } = await import("@/lib/auth");
          await completeLogin(code, state);
          return redirectTo("/profiles", 303);
        } catch (err) {
          console.error("OIDC callback error", err);
          return redirectTo("/auth?error=oidc-failed", 302);
        }
      },
    },
  },
});
