import { Link } from "@tanstack/react-router";

export function Logo({ className = "" }: { className?: string }) {
  return (
    <Link
      to="/browse"
      className={`inline-flex items-center gap-2.5 ${className}`}
      aria-label="OPLAY.ID browse"
    >
      <span className="text-primary font-black tracking-tighter text-2xl sm:text-3xl select-none">
        OPLAY<span className="text-foreground">.ID</span>
      </span>
    </Link>
  );
}
