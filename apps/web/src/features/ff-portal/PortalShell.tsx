import type { ReactNode } from "react";
import type { FfPortalRfqDto } from "@svyft/shared";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
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

  const validityDateValue = quoteValidityUntil
    ? quoteValidityUntil.slice(0, 10)
    : "";

  function handleValidityChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    if (!val) {
      onValidityChange(null);
    } else {
      onValidityChange(new Date(val).toISOString());
    }
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Trust band header */}
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-b-primary/70 bg-card px-4 py-3 sm:px-6">
        {/* Left: wordmark + RFQ meta */}
        <div className="flex flex-col gap-1">
          <span className="font-display text-base font-semibold tracking-tight">
            Svyft <span className="text-primary">Logistics</span>
          </span>
          <p className="text-xs text-muted-foreground">Request for quote</p>
          <p className="text-sm">
            Prepared for{" "}
            <span className="font-medium">
              {rfq.freightForwarder.companyName}
            </span>
          </p>
          <div className="flex items-center gap-2">
            <span className="font-mono tabular-nums text-sm">
              {rfq.rfqNumber}
            </span>
            {rfq.incoterms && (
              <Badge variant="outline">{rfq.incoterms}</Badge>
            )}
          </div>
        </div>

        {/* Right: signature deadline countdown */}
        <div className="flex flex-col items-end gap-1">
          <p className="text-xs text-muted-foreground">Deadline</p>
          <span
            className={`font-mono tabular-nums rounded-md px-2.5 py-1 text-sm ${countdownChipClass(cd.tier)}`}
          >
            {cd.text}
          </span>
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

        {/* Leg sections */}
        {children}
      </main>

      {/* Footer */}
      <footer className="border-t py-4 text-center text-xs text-muted-foreground">
        Svyft Logistics · secure RFQ link
      </footer>
    </div>
  );
}
