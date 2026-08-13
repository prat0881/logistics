import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import type { FfPortalRfqDto } from "@svyft/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCountdown } from "./useCountdown";
import type { CountdownTier } from "./useCountdown";
import { ScopedRouteDiagram } from "./ScopedRouteDiagram";
import { RfqPrintView } from "./RfqPrintView";

const CURRENCIES = ["USD", "EUR", "GBP", "INR", "AED"];

function countdownChipClass(tier: CountdownTier): string {
  switch (tier) {
    case "calm":
      return "text-muted-foreground bg-muted";
    case "warning":
      return "text-warning bg-warning/10";
    case "urgent":
      return "text-destructive bg-destructive/10";
    case "expired":
      return "text-destructive-foreground bg-destructive";
  }
}

export interface PortalShellProps {
  rfq: FfPortalRfqDto;
  currency: string | null;
  onCurrencyChange: (v: string) => void;
  quoteValidityUntil: string | null;
  onValidityChange: (iso: string | null) => void;
  children: ReactNode;
}

export function PortalShell({
  rfq,
  currency,
  onCurrencyChange,
  quoteValidityUntil,
  onValidityChange,
  children,
}: PortalShellProps): JSX.Element {
  const cd = useCountdown(rfq.submissionDeadline);

  const validityDateValue = quoteValidityUntil ? quoteValidityUntil.slice(0, 10) : "";

  function handleValidityChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    if (!val) {
      onValidityChange(null);
    } else {
      onValidityChange(new Date(val).toISOString());
    }
  }

  // RFQ PDF download + preview (design §4.8.14). RfqPrintView is mounted on demand — not
  // unconditionally — so it never sits hidden-but-queryable in the DOM (and duplicating the
  // header's RFQ number/company/incoterims text) during normal use. `printMounted` gates a
  // `hidden print:block` container that `window.print()` turns into a PDF via the browser's own
  // "Save as PDF"; `previewOpen` gates a read-only Dialog showing the same document on screen.
  // Both render the same <RfqPrintView>, built from the frozen RFQ DTO — never the FF's
  // in-progress quote amounts (those live in per-leg forms, not reachable from here).
  const [previewOpen, setPreviewOpen] = useState(false);
  const [printMounted, setPrintMounted] = useState(false);

  // Unmount the print-only copy again once the browser's print/save-as-PDF flow finishes.
  useEffect(() => {
    function onAfterPrint() {
      setPrintMounted(false);
    }
    window.addEventListener("afterprint", onAfterPrint);
    return () => window.removeEventListener("afterprint", onAfterPrint);
  }, []);

  function handleDownloadPdf() {
    // flushSync forces React to commit printMounted=true (and close any open preview) to the DOM
    // synchronously before window.print() runs. Without it, the state update would still be
    // batched/pending when print() reads the DOM, producing a blank page.
    flushSync(() => {
      setPreviewOpen(false);
      setPrintMounted(true);
    });
    window.print();
  }

  return (
    <>
      <div className="min-h-screen bg-background print:hidden">
        {/* Trust band header */}
        <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-b-primary/70 bg-card px-4 py-3 sm:px-6">
          {/* Left: wordmark + RFQ meta */}
          <div className="flex flex-col gap-1">
            <span className="font-display text-base font-semibold tracking-tight">
              Svyft <span className="text-primary">Logistics</span>
            </span>
            <p className="text-xs text-muted-foreground">Request for quote</p>
            <p className="text-sm">
              Prepared for <span className="font-medium">{rfq.freightForwarder.companyName}</span>
            </p>
            <div className="flex items-center gap-2">
              <span className="font-mono tabular-nums text-sm">{rfq.rfqNumber}</span>
              {rfq.incoterms && <Badge variant="outline">{rfq.incoterms}</Badge>}
            </div>
          </div>

          {/* Right: RFQ document actions + signature deadline countdown */}
          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPreviewOpen(true)}
              >
                Preview
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={handleDownloadPdf}>
                Download PDF
              </Button>
            </div>
            <div className="flex flex-col items-end gap-1">
              <p className="text-xs text-muted-foreground">Deadline</p>
              <span
                className={`font-mono tabular-nums rounded-md px-2.5 py-1 text-sm ${countdownChipClass(cd.tier)}`}
              >
                {cd.text}
              </span>
            </div>
          </div>
        </header>

        {/* Main content column */}
        <main className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6">
          {/* RFQ-level fields */}
          <Card id="rfq-fields">
            <CardContent className="flex flex-wrap gap-6 pt-6">
              {/* Currency */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="rfq-currency">Currency</Label>
                <Select value={currency ?? ""} onValueChange={onCurrencyChange}>
                  <SelectTrigger id="rfq-currency" className="w-32">
                    <SelectValue placeholder="Select…" />
                  </SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Quote validity until */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="rfq-validity">Quote validity until</Label>
                <Input
                  id="rfq-validity"
                  type="date"
                  value={validityDateValue}
                  onChange={handleValidityChange}
                  className="w-44"
                />
              </div>
            </CardContent>
          </Card>

          {/* Route overview — assignment-scoped, address-masked (design §4.8.3) */}
          <ScopedRouteDiagram legs={rfq.legs} />

          {/* Leg sections */}
          {children}
        </main>

        {/* Footer */}
        <footer className="border-t py-4 text-center text-xs text-muted-foreground">
          Svyft Logistics · secure RFQ link
        </footer>
      </div>

      {/* Print-only document (design §4.8.14): mounted on demand by handleDownloadPdf, so it
          exists in the DOM only while actually printing. The rest of the chrome above is
          print:hidden, so this `print:block` container is the only thing a real browser prints. */}
      {printMounted && (
        <div className="hidden print:block">
          <RfqPrintView rfq={rfq} />
        </div>
      )}

      {/* Read-only RFQ preview — same document, rendered on screen */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-h-[85vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>RFQ preview — {rfq.rfqNumber}</DialogTitle>
          </DialogHeader>
          <RfqPrintView rfq={rfq} />
        </DialogContent>
      </Dialog>
    </>
  );
}
