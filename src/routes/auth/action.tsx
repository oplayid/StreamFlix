import { createFileRoute } from "@tanstack/react-router";
import { Logo } from "@/components/streamflix/Logo";
import heroImg from "@/assets/hero-1.jpg";

export const Route = createFileRoute("/auth/action")({
  ssr: false,
  component: ActionPage,
});

function ActionPage() {
  return (
    <main className="relative grid min-h-dvh place-items-center">
      <img src={heroImg} alt="" className="absolute inset-0 size-full object-cover" />
      <div className="absolute inset-0 bg-black/75" />
      <div className="relative z-10 rounded-md bg-black/75 p-10 text-center">
        <Logo />
        <h1 className="mt-6 text-2xl font-bold">No action needed</h1>
        <p className="mt-3 max-w-sm text-sm text-muted-foreground">
          Accounts are managed by OPLAY.ID Passkey. Use your OPLAY.ID Passkey to sign in, reset your
          password, or verify your email.
        </p>
        <a
          href="/auth"
          className="mt-8 inline-block rounded bg-primary px-6 py-3 font-semibold text-primary-foreground hover:bg-primary/90"
        >
          Back to sign in
        </a>
      </div>
    </main>
  );
}
