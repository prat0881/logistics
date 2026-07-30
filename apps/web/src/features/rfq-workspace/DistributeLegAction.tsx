import { useState } from "react";
import type { DistributeResult } from "@svyft/shared";
import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { useDistributeLeg } from "./useRfq";
import { PortalLinkRow } from "./PortalLinkRow";

export const GATE_CODE_LABEL: Record<string, string> = {
  F1_INCOMPLETE_LEG:
    "The leg is incomplete — it needs an origin, destination, mode, cargo and dates before it can be distributed.",
  F4_LEG_NOT_READY:
    "The leg has unresolved validation issues from Create Query and is not ready for RFQ.",
  F5_DG_FF_CANNOT_HANDLE:
    "A selected forwarder cannot handle Dangerous Goods, but this leg carries DG cargo.",
};

export function localToIso(local: string): string | undefined {
  if (!local) return undefined;
  const ms = Date.parse(local);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

function extractCodes(err: ApiError): string[] {
  const body = err.body as { codes?: unknown } | undefined;
  return Array.isArray(body?.codes) ? (body!.codes as string[]) : [];
}

interface Props {
  queryId: string;
  legId: string;
  deadlineLocal: string;
  canDistribute: boolean;
}

export function DistributeLegAction({ queryId, legId, deadlineLocal, canDistribute }: Props) {
  const distribute = useDistributeLeg(queryId, legId);
  const [codes, setCodes] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<DistributeResult | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function run(confirm: boolean) {
    setCodes([]);
    setMessage(null);
    setResult(null);
    try {
      const res = await distribute.mutateAsync({ submissionDeadline: localToIso(deadlineLocal), confirm });
      setResult(res);
      setConfirmOpen(false);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setConfirmOpen(true);
          return;
        }
        const gate = extractCodes(err);
        if (gate.length) setCodes(gate);
        else setMessage(err.message);
      } else {
        setMessage("Distribution failed. Please try again.");
      }
    }
  }

  return (
    <div className="space-y-2">
      <Button disabled={!canDistribute || distribute.isPending} onClick={() => void run(false)}>
        {distribute.isPending ? "Distributing…" : "Distribute RFQ"}
      </Button>

      {codes.length > 0 && (
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3">
          {codes.map((c) => (
            <p key={c} className="text-sm text-destructive">
              {GATE_CODE_LABEL[c] ?? c}
            </p>
          ))}
        </div>
      )}
      {message && (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}

      {result && result.rfqs.length > 0 && (
        <div className="rounded-md border border-success/30 bg-success/10 p-3 text-sm">
          {result.rfqs.map((r) => (
            <div key={r.rfqId} className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{r.rfqNumber}</span>
              <span className="text-muted-foreground">{r.minted ? "sent" : "updated"}</span>
              {r.accessToken && (
                <PortalLinkRow url={`${window.location.origin}/ff/rfq/${r.accessToken}`} />
              )}
            </div>
          ))}
        </div>
      )}
      {result && result.rfqs.length === 0 && result.skipped.length > 0 && (
        <p className="text-sm text-muted-foreground">Nothing new to send (already distributed).</p>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Re-distribute this RFQ?</DialogTitle>
            <DialogDescription>
              The selected forwarders have already been sent this RFQ. Confirm to re-distribute.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void run(true)} disabled={distribute.isPending}>
              Re-distribute
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
