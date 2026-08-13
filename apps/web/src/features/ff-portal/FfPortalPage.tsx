import { useState, useEffect, useMemo } from "react";
import { useParams } from "react-router-dom";
import type { FfPortalRfqDto } from "@svyft/shared";
import { useFfRfq } from "./useFfPortal";
import { PortalShell } from "./PortalShell";
import { LegSection } from "./LegSection";
import { InvalidTokenCard, ExpiredBanner } from "./terminalStates";
import { usePortalHead } from "./usePortalHead";
import { orderLegsByRoute } from "./legOrder";

export function FfPortalPage(): JSX.Element {
  usePortalHead("Request for quote · Svyft Logistics");

  const { token } = useParams();
  const { data: rfq, isLoading, isError } = useFfRfq(token!);

  if (isLoading) {
    return (
      <div
        role="status"
        className="flex min-h-screen items-center justify-center text-muted-foreground"
      >
        Loading…
      </div>
    );
  }

  if (isError || !rfq) {
    return <InvalidTokenCard />;
  }

  return <FfPortalLoaded token={token!} rfq={rfq} />;
}

// Inner component — only mounts once `rfq` is defined, so useState seeds correctly.
function FfPortalLoaded({ token, rfq }: { token: string; rfq: FfPortalRfqDto }): JSX.Element {
  const [currency, setCurrency] = useState<string | null>(rfq.currency);
  const [validity, setValidity] = useState<string | null>(rfq.quoteValidityUntil);

  useEffect(() => {
    if (currency == null && rfq.currency != null) setCurrency(rfq.currency);
  }, [rfq.currency, currency]);
  useEffect(() => {
    if (validity == null && rfq.quoteValidityUntil != null) setValidity(rfq.quoteValidityUntil);
  }, [rfq.quoteValidityUntil, validity]);

  const expired = Date.now() > Date.parse(rfq.submissionDeadline);

  // Round 4 (#2): legs render in route-diagram TOPOLOGY order, not the Prisma assignment order
  // rfq.legs arrives in — see legOrder.ts.
  const orderedLegs = useMemo(() => orderLegsByRoute(rfq.legs), [rfq.legs]);

  // Round 4 (#1): one leg expanded at a time, first leg (in route order) open by default —
  // mirrors the executive RfqWorkspace's openLegId + LegPanel pattern. This component only
  // mounts once `rfq` is defined (see FfPortalPage above), so a plain useState initializer seeds
  // correctly without needing the executive's mount-guard/effect dance.
  const [openLegId, setOpenLegId] = useState<string | null>(orderedLegs[0]?.legId ?? null);

  return (
    <PortalShell
      rfq={rfq}
      currency={currency}
      onCurrencyChange={setCurrency}
      quoteValidityUntil={validity}
      onValidityChange={setValidity}
    >
      {expired && <ExpiredBanner />}
      {orderedLegs.map((leg) => (
        <LegSection
          key={leg.legId}
          token={token}
          rfq={rfq}
          leg={leg}
          currency={currency}
          quoteValidityUntil={validity}
          readOnly={expired}
          open={openLegId === leg.legId}
          onOpen={() => setOpenLegId(leg.legId)}
        />
      ))}
    </PortalShell>
  );
}
