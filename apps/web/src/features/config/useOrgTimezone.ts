import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import { DEFAULT_ORG_TIMEZONE, type OrgTimezoneDto } from "@svyft/shared";

export function useOrgTimezone(): { orgZone: string; isLoading: boolean } {
  const q = useQuery({
    queryKey: ["org-timezone"],
    queryFn: () => fetchJson<OrgTimezoneDto>("/api/config/org-timezone"),
    staleTime: 5 * 60_000,
  });
  return { orgZone: q.data?.timezone ?? DEFAULT_ORG_TIMEZONE, isLoading: q.isLoading };
}
