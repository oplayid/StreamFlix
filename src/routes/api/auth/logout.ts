import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/auth/logout")({
  server: {
    handlers: {
      POST: async () => {
        const { logout, redirectTo } = await import("@/lib/auth");
        await logout();
        return redirectTo("/auth", 303);
      },
      GET: async () => {
        const { logout, redirectTo } = await import("@/lib/auth");
        await logout();
        return redirectTo("/auth", 303);
      },
    },
  },
});
