import { Link } from "@tanstack/react-router";

export function Footer() {
  return (
    <footer className="border-t border-border bg-background px-4 sm:px-8 py-6 text-sm text-muted-foreground">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-5 sm:flex-row sm:justify-between">
        <p className="text-center text-xs sm:text-left sm:text-sm">
          Made by OPLAY.ID
        </p>
        <nav className="flex flex-wrap items-center justify-center gap-x-4 gap-y-3 text-xs text-muted-foreground sm:justify-end">
          <Link to="/tos" className="hover:text-foreground">
            Terms of Service
          </Link>
          <Link to="/privacy-policy" className="hover:text-foreground">
            Privacy Policy
          </Link>
        </nav>
      </div>
    </footer>
  );
}
