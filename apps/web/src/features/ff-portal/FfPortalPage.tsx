import { useState } from "react";
import { useParams } from "react-router-dom";
import type { FfPortalRfqDto } from "@svyft/shared";
import { useFfRfq } from "./useFfPortal";
import { PortalShell } from "./PortalShell";
import { LegSection } from "./LegSection";
import { InvalidTokenCard, ExpiredBanner } from "./terminalStates";
import { usePortalHead } from "./usePortalHead";

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
function FfPortalLoaded({
  token,
  rfq,
}: {
  token: string;
  rfq: FfPortalRfqDto;
}): JSX.Element {
  const [currency, setCurrency] = useState<string | null>(rfq.currency);
  const [validity, setValidity] = useState<string | null>(rfq.quoteValidityUntil);

  const expired = Date.now() > Date.parse(rfq.submissionDeadline);

  return (
    <PortalShell
      rfq={rfq}
      currency={currency}
      onCurrencyChange={setCurrency}
      quoteValidityUntil={validity}
      onValidityChange={setValidity}
    >
      {expired && <ExpiredBanner />}
      {rfq.legs.map((leg) => (
        <LegSection
          key={leg.legId}
          token={token}
          rfq={rfq}
          leg={leg}
          currency={currency}
          quoteValidityUntil={validity}
          readOnly={expired}
        />
      ))}
    </PortalShell>
  );
}
