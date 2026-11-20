import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Logo } from "@/components/streamflix/Logo";
import { getSession } from "@/lib/session";
import heroImg from "@/assets/hero-1.jpg";

export const Route = createFileRoute("/auth")({
  ssr: false,
  head: () => ({ meta: [{ title: "Sign In — StreamFlix" }] }),
  component: AuthPage,
});

function AuthPage() {
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("error");
    if (code) {
      const messages: Record<string, string> = {
        "oidc-denied": "Sign-in was cancelled or denied by Pocket ID.",
        "oidc-failed": "Could not complete sign-in. Please try again.",
        "oidc-unavailable": "Pocket ID is not reachable. Check the OIDC configuration.",
      };
      setError(messages[code] ?? "Sign-in failed.");
    }
    getSession()
      .then((user) => {
        if (user) window.location.replace("/profiles");
      })
      .finally(() => setChecking(false));
  }, []);

  return (
    <main className="relative min-h-dvh">
      <img src={heroImg} alt="" className="absolute inset-0 size-full object-cover" />
      <div className="absolute inset-0 bg-black/70" />
      <div className="relative z-10">
        <header className="flex items-center justify-between px-4 py-5 sm:px-12">
          <Logo />
          <Link
            to="/"
            className="rounded-md border border-border px-4 py-2 text-sm text-muted-foreground hover:border-foreground hover:text-foreground"
          >
            Back to Home
          </Link>
        </header>

        <div className="mx-auto mt-4 max-w-md rounded-md bg-black/75 p-8 sm:p-12">
          <h1 className="text-3xl font-bold">Sign In</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            StreamFlix uses your Pocket ID account. One login for everything—no separate password
            to remember.
          </p>

          {error && (
            <div className="mt-6 rounded border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-400">
              {error}
            </div>
          )}

          <a
            href="/api/auth/login"
            className="mt-8 flex w-full items-center justify-center gap-2 rounded bg-primary py-3 font-semibold text-primary-foreground transition hover:bg-primary/90"
          >
            Continue with Pocket ID
          </a>

          <p className="mt-6 text-center text-xs text-muted-foreground">
            {checking ? "Checking your session…" : "Protected by OpenID Connect · PKCE"}
          </p>
        </div>
      </div>
    </main>
  );
}
