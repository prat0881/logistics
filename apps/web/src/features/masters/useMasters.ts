import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api";
import type {
  ChargeLineDefinitionAdminDto,
  ClientDto,
  ContactDto,
  FreightForwarderDto,
  Paginated,
  VesselDto,
  WarehouseDto,
} from "@svyft/shared";

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

/**
 * Unlike ClientDto/WarehouseDto, FreightForwarderDto does not embed `contacts` — GET
 * /api/freight-forwarders/:id returns only the parent row (FreightForwardersService.get has no
 * `include`). Its contacts live behind the dedicated GET /:id/contacts endpoint instead, so the
 * form page's edit-mode load effect needs this separate query to seed the `contacts` field.
 */
export function useFreightForwarderContacts(id: string | undefined) {
  return useQuery({
    queryKey: ["freight-forwarder", id, "contacts"],
    queryFn: () => fetchJson<ContactDto[]>(`/api/freight-forwarders/${id}/contacts`),
    enabled: !!id,
  });
}

export function useWarehouses(params: { q: string; page: number; pageSize: number }) {
  const { q, page, pageSize } = params;
  return useQuery({
    queryKey: ["warehouses", q, page, pageSize],
    queryFn: () =>
      fetchJson<Paginated<WarehouseDto>>(
        `/api/warehouses?q=${encodeURIComponent(q)}&page=${page}&pageSize=${pageSize}`,
      ),
  });
}

export function useWarehouse(id: string | undefined) {
  return useQuery({
    queryKey: ["warehouse", id],
    queryFn: () => fetchJson<WarehouseDto>(`/api/warehouses/${id}`),
    enabled: !!id,
  });
}

/**
 * The warehouses currently assigned to a freight forwarder or client — the `assigned` half of
 * WarehousePicker's data (the other half, unassigned warehouses, is fetched by the picker
 * itself via `?unassigned=true`). Keyed the same way ContactList keys its owner-scoped list, so
 * a save that invalidates `[ownerPath, ownerId, "warehouses"]` refetches this.
 */
export function useOwnerWarehouses(ownerPath: "freight-forwarders" | "clients", ownerId: string | undefined) {
  return useQuery({
    queryKey: [ownerPath, ownerId, "warehouses"],
    queryFn: () => fetchJson<WarehouseDto[]>(`/api/${ownerPath}/${ownerId}/warehouses`),
    enabled: Boolean(ownerId),
  });
}

/**
 * `charge-catalogue-admin` is a deliberately distinct query key from the RFQ workspace's
 * `charge-catalogue` (apps/web/src/features/rfq-workspace/useChargeConfig.ts, a do-not-touch
 * file) — that hook fetches the pre-existing `GET /api/charge-line-definitions` (active-only,
 * role/zone shaped) into the SAME cache under that key. Reusing it here would make two
 * differently-shaped, differently-scoped responses fight over one cache entry. This hook
 * fetches the additive `GET /api/charge-line-definitions/admin` (every row, category/variant/
 * isAdditional shaped) instead, so the two features never share cache state.
 */
export function useChargeCatalogueAdmin() {
  return useQuery({
    queryKey: ["charge-catalogue-admin"],
    queryFn: () => fetchJson<ChargeLineDefinitionAdminDto[]>("/api/charge-line-definitions/admin"),
  });
}
