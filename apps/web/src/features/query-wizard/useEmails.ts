import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson, postJson } from "@/lib/api";
import type { EmailLogDto } from "@svyft/shared";

/**
 * Per-query email log hook.
 * - `list`: ordered newest-first from `GET /api/queries/:id/emails`
 * - `sendFollowUp`: POST /api/queries/:id/emails/follow-up
 * - `sendAck`: POST /api/queries/:id/emails/acknowledgement
 * Both mutations invalidate the list query on success.
 */
export function useEmails(queryId: string | undefined) {
  const qc = useQueryClient();

  const list = useQuery({
    queryKey: ["emails", queryId],
    queryFn: () => fetchJson<EmailLogDto[]>(`/api/queries/${queryId}/emails`),
    enabled: !!queryId,
  });

  const sendFollowUp = useMutation({
    mutationFn: () =>
      postJson<unknown>(`/api/queries/${queryId}/emails/follow-up`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["emails", queryId] });
    },
  });

  const sendAck = useMutation({
    mutationFn: () =>
      postJson<unknown>(`/api/queries/${queryId}/emails/acknowledgement`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["emails", queryId] });
    },
  });

  return { list, sendFollowUp, sendAck };
}
