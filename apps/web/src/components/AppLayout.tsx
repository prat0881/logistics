import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Role } from "@svyft/shared";
import { useAuth } from "@/features/auth/AuthProvider";
import { Button } from "@/components/ui/button";

export function AppLayout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const isAdmin = user?.role === Role.ADMINISTRATOR;
  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between border-b border-b-primary/70 bg-card px-6 py-3">
        <nav className="flex items-center gap-5 text-sm">
          <Link
            to="/"
            className="font-display text-base font-semibold tracking-tight text-foreground"
          >
            Svyft <span className="text-primary">Logistics</span>
          </Link>
          <Link to="/queries" className="text-muted-foreground hover:text-foreground">
            Queries
          </Link>
          <Link to="/masters/clients" className="text-muted-foreground hover:text-foreground">
            Clients
          </Link>
          <Link to="/masters/vessels" className="text-muted-foreground hover:text-foreground">
            Vessels
          </Link>
          {isAdmin && (
            <Link to="/admin/config" className="text-muted-foreground hover:text-foreground">
              Config
            </Link>
          )}
        </nav>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">
            {user?.name} ({user?.role})
          </span>
          <Button variant="outline" size="sm" onClick={() => void logout()}>
            Log out
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-7xl p-6">{children}</main>
    </div>
  );
}
