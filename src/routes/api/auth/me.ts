import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/auth/me")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const { getCurrentUser } = await import("@/lib/auth");
          const user = await getCurrentUser();
          return Response.json({ user });
        } catch (error) {
          return Response.json({ user: null, error: String(error) }, { status: 500 });
        }
      },
    },
  },
});
