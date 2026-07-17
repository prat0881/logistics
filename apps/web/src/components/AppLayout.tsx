import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Role } from "@svyft/shared";
import { useAuth } from "@/features/auth/AuthProvider";
import { Button } from "@/components/ui/button";

export function AppLayout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const isAdmin = user?.role === Role.ADMINISTRATOR;
  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <nav className="flex items-center gap-4 text-sm">
          <Link to="/" className="font-semibold">
            Svyft Logistics
          </Link>
          <Link to="/masters/clients">Clients</Link>
          <Link to="/masters/vessels">Vessels</Link>
          {isAdmin && <Link to="/admin/config">Config</Link>}
        </nav>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-slate-600">
            {user?.name} ({user?.role})
          </span>
          <Button variant="outline" onClick={() => void logout()}>
            Log out
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-4xl p-6">{children}</main>
    </div>
  );
}
