import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { getSession } from "@/lib/session";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async ({ location, context }) => {
    // Share the same cache as useSession() so navigation does not refetch auth.
    const user = await context.queryClient.fetchQuery({
      queryKey: ["sf", "session"],
      queryFn: () => getSession(),
      staleTime: 5 * 60_000,
    });
    if (!user) {
      throw redirect({ to: "/auth" });
    }
    let pending = false;
    try {
      pending = localStorage.getItem("sf:upgrade_password") === "1";
    } catch {}
    if (pending && location.pathname !== "/force-password") {
      throw redirect({ to: "/force-password" });
    }
    return { user };
  },
  component: () => <Outlet />,
});
