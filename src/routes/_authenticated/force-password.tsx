import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { signOutFn } from "@/lib/session";

export const Route = createFileRoute("/_authenticated/force-password")({
  ssr: false,
  head: () => ({ meta: [{ title: "Password managed by OPLAY.ID Passkey — OPLAY.ID" }] }),
  component: ForcePasswordPage,
});

function ForcePasswordPage() {
  const navigate = useNavigate();

  return (
    <div className="grid min-h-dvh place-items-center bg-background p-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card/40 p-6 text-center">
        <ShieldCheck className="mx-auto mb-3 size-10 text-primary" />
        <h1 className="text-lg font-semibold">Password managed by OPLAY.ID Passkey</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          OPLAY.ID no longer stores passwords. Use OPLAY.ID Passkey to change or reset your password.
        </p>
        <button
          onClick={async () => {
            try { localStorage.removeItem("sf:upgrade_password"); } catch {}
            navigate({ to: "/profiles" });
          }}
          className="mt-4 rounded bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
        >
          Continue
        </button>
        <button
          onClick={async () => {
            await signOutFn();
            navigate({ to: "/auth" });
          }}
          className="mt-2 block w-full text-sm text-muted-foreground hover:text-foreground"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
