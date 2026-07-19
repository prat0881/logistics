import { HealthStatus } from "@/features/health/HealthStatus";

export function HomePage() {
  return (
    <div className="space-y-6">
      <h1 className="font-display text-xl font-semibold tracking-tight">Dashboard</h1>
      <HealthStatus />
    </div>
  );
}
