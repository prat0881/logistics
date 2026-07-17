import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { ClientDto, Paginated, VesselDto } from "@svyft/shared";

export function useClients(q: string) {
  return useQuery({
    queryKey: ["clients", q],
    queryFn: () => fetchJson<Paginated<ClientDto>>(`/api/clients?q=${encodeURIComponent(q)}`),
  });
}
export function useClient(id: string | undefined) {
  return useQuery({
    queryKey: ["client", id],
    queryFn: () => fetchJson<ClientDto>(`/api/clients/${id}`),
    enabled: !!id,
  });
}
export function useVessels(q: string) {
  return useQuery({
    queryKey: ["vessels", q],
    queryFn: () => fetchJson<Paginated<VesselDto>>(`/api/vessels?q=${encodeURIComponent(q)}`),
  });
}
export function useVessel(id: string | undefined) {
  return useQuery({
    queryKey: ["vessel", id],
    queryFn: () => fetchJson<VesselDto>(`/api/vessels/${id}`),
    enabled: !!id,
  });
}
