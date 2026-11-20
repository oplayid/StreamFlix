import { createServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import type { AuthUser } from "./auth";

export type { AuthUser };

/** Returns the signed-in Pocket ID user, or null. */
export const getSession = createServerFn({ method: "GET" }).handler(
  async (): Promise<AuthUser | null> => {
    const { getCurrentUser } = await import("./auth");
    return getCurrentUser();
  },
);

export const signOutFn = createServerFn({ method: "POST" }).handler(async () => {
  const { logout } = await import("./auth");
  await logout();
  return { ok: true };
});

/** Client hook shared by UI components. */
export function useSession() {
  const query = useQuery({
    queryKey: ["sf", "session"],
    queryFn: () => getSession(),
    staleTime: 60_000,
    retry: false,
  });
  return {
    user: query.data ?? null,
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}
