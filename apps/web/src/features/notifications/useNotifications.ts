import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson, patchJson } from "@/lib/api";
import type { NotificationDto, UnreadCountDto } from "@svyft/shared";

export function useNotifications() {
  const qc = useQueryClient();

  const unread = useQuery({
    queryKey: ["notifications", "unread-count"],
    queryFn: () => fetchJson<UnreadCountDto>("/api/notifications/unread-count"),
    refetchInterval: 45_000,
  });

  const list = useQuery({
    queryKey: ["notifications", "list"],
    queryFn: () => fetchJson<NotificationDto[]>("/api/notifications"),
    enabled: false, // fetched on open (see NotificationBell)
  });

  const markRead = useMutation({
    mutationFn: (id: string) =>
      patchJson<unknown>(`/api/notifications/${id}/read`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["notifications", "unread-count"] });
      void qc.invalidateQueries({ queryKey: ["notifications", "list"] });
    },
  });

  return {
    unreadCount: unread.data?.count ?? 0,
    list,
    markRead,
  };
}
