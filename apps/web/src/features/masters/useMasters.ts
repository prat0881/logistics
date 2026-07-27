import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type { ClientDto, FreightForwarderDto, Paginated, VesselDto } from "@svyft/shared";

export function useClients(params: { q: string; page: number; pageSize: number }) {
  const { q, page, pageSize } = params;
  return useQuery({
    queryKey: ["clients", q, page, pageSize],
    queryFn: () =>
      fetchJson<Paginated<ClientDto>>(
        `/api/clients?q=${encodeURIComponent(q)}&page=${page}&pageSize=${pageSize}`,
      ),
  });
}
export function useClient(id: string | undefined) {
  return useQuery({
    queryKey: ["client", id],
    queryFn: () => fetchJson<ClientDto>(`/api/clients/${id}`),
    enabled: !!id,
  });
}
export function useVessels(params: { q: string; page: number; pageSize: number }) {
  const { q, page, pageSize } = params;
  return useQuery({
    queryKey: ["vessels", q, page, pageSize],
    queryFn: () =>
      fetchJson<Paginated<VesselDto>>(
        `/api/vessels?q=${encodeURIComponent(q)}&page=${page}&pageSize=${pageSize}`,
      ),
  });
}
export function useVessel(id: string | undefined) {
  return useQuery({
    queryKey: ["vessel", id],
    queryFn: () => fetchJson<VesselDto>(`/api/vessels/${id}`),
    enabled: !!id,
  });
}

export function useFreightForwarders(params: { q: string; page: number; pageSize: number }) {
  const { q, page, pageSize } = params;
  return useQuery({
    queryKey: ["freight-forwarders", q, page, pageSize],
    queryFn: () =>
      fetchJson<Paginated<FreightForwarderDto>>(
        `/api/freight-forwarders?q=${encodeURIComponent(q)}&page=${page}&pageSize=${pageSize}`,
      ),
  });
}

export function useFreightForwarder(id: string | undefined) {
  return useQuery({
    queryKey: ["freight-forwarder", id],
    queryFn: () => fetchJson<FreightForwarderDto>(`/api/freight-forwarders/${id}`),
    enabled: !!id,
  });
}
