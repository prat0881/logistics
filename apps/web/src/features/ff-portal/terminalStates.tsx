import type { FfPortalLegDto, FfPortalRfqDto } from "@svyft/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CargoManifestTable } from "./CargoManifestTable";
import { QuoteSummary } from "./QuoteSummary";
import { draftFromDto } from "./draftFromDto";

/** Displayed when the token is invalid or the RFQ no longer exists. */
export function InvalidTokenCard(): JSX.Element {
  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <Card className="max-w-md w-full">
        <CardHeader>
          <CardTitle>Link unavailable</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>This RFQ link is invalid or has expired.</p>
          <p>
            If you believe this is a mistake, contact your Svyft Logistics
            representative.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/** Banner shown when the submission deadline has passed. */
export function ExpiredBanner(): JSX.Element {
  return (
    <div
      role="status"
      className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
    >
      The submission deadline has passed — this RFQ can no longer be submitted.
    </div>
  );
}

/** Read-only summary card for a leg that has already been submitted (QUOTED status). */
export function AlreadySubmittedSummary({
  leg,
  rfq,
}: {
  leg: FfPortalLegDto;
  rfq: FfPortalRfqDto;
}): JSX.Element {
  const draft = leg.draft ?? draftFromDto(leg, rfq);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-3 pb-2">
        <CardTitle className="text-base">Quote</CardTitle>
        <Badge variant="success">Quote submitted</Badge>
      </CardHeader>
      <CardContent className="space-y-6">
        <CargoManifestTable cargo={leg.manifest.cargo} />
        <QuoteSummary draft={draft} currency={rfq.currency} />
      </CardContent>
    </Card>
  );
}
