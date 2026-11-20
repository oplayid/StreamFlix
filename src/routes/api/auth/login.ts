import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/auth/login")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const { buildAuthorizationUrl } = await import("@/lib/auth");
          const url = await buildAuthorizationUrl();
          return Response.redirect(url, 302);
        } catch (error) {
          console.error("OIDC login error", error);
          const { redirectTo } = await import("@/lib/auth");
          return redirectTo("/auth?error=oidc-unavailable", 302);
        }
      },
    },
  },
});
