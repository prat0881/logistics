import { HealthStatus } from "@/features/health/HealthStatus";

export function HomePage() {
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Dashboard</h1>
      <HealthStatus />
    </div>
  );
}
