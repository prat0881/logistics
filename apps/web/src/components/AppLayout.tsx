import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Role } from "@svyft/shared";
import { useAuth } from "@/features/auth/AuthProvider";
import { useCanWrite } from "@/features/auth/useCanWrite";
import { Button } from "@/components/ui/button";
import { NotificationBell } from "@/features/notifications/NotificationBell";

export function AppLayout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const isAdmin = user?.role === Role.ADMINISTRATOR;
  // The charge catalogue screen's only data source (GET /api/charge-line-definitions/admin)
  // is gated to Administrator OR Manager — matching that here, not isAdmin, or a Manager would
  // see the link 404 into an AdminOnly redirect despite having real access.
  const canSeeChargeCatalogue = useCanWrite();
  return (
    <div className="min-h-screen bg-background">
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-b-primary/70 bg-card px-4 py-3 sm:px-6">
        <nav className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
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
          <Link
            to="/masters/freight-forwarders"
            className="text-muted-foreground hover:text-foreground"
          >
            Forwarders
          </Link>
          <Link to="/masters/fx-rates" className="text-muted-foreground hover:text-foreground">
            FX Rates
          </Link>
          <Link to="/masters/warehouses" className="text-muted-foreground hover:text-foreground">
            Warehouses
          </Link>
          {canSeeChargeCatalogue && (
            <Link to="/masters/charge-catalogue" className="text-muted-foreground hover:text-foreground">
              Charge Catalogue
            </Link>
          )}
          {isAdmin && (
            <Link to="/admin/config" className="text-muted-foreground hover:text-foreground">
              Config
            </Link>
          )}
        </nav>
        <div className="flex items-center gap-3 text-sm">
          <NotificationBell />
          <span className="text-muted-foreground">
            {user?.name} ({user?.role})
          </span>
          <Button variant="outline" size="sm" onClick={() => void logout()}>
            Log out
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-7xl p-4 sm:p-6">{children}</main>
    </div>
  );
}
