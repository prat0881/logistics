import { useAuth } from "@/features/auth/AuthProvider";
import { HealthStatus } from "@/features/health/HealthStatus";
import { Button } from "@/components/ui/button";

export function HomePage() {
  const { user, logout } = useAuth();
  return (
    <main className="mx-auto max-w-xl space-y-6 p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Svyft Logistics</h1>
          <p className="text-sm text-slate-600">
            Signed in as {user?.name} ({user?.role})
          </p>
        </div>
        <Button variant="outline" onClick={() => void logout()}>
          Log out
        </Button>
      </div>
      <HealthStatus />
    </main>
  );
}
