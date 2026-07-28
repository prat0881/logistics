import type { LegStatus, QuoteStatus } from "@svyft/shared";
import { Badge } from "@/components/ui/badge";

type BadgeVariant =
  | "default" | "secondary" | "success" | "warning"
  | "accent" | "destructive" | "outline" | "pending";

function legStatusVariant(s: LegStatus): BadgeVariant {
  switch (s) {
    case "DRAFT": return "pending";
    case "READY_FOR_RFQ": return "default";
    case "RFQ_SENT": return "accent";
    case "PARTIALLY_QUOTED": return "warning";
    case "FULLY_QUOTED":
    case "AWARDED": return "success";
    default: return "outline";
  }
}

// Leg status display labels
const LEG_LABEL: Record<LegStatus, string> = {
  DRAFT: "Draft",
  READY_FOR_RFQ: "Ready For Rfq",
  RFQ_SENT: "RFQ Sent",
  PARTIALLY_QUOTED: "Partially Quoted",
  FULLY_QUOTED: "Fully Quoted",
  AWARDED: "Awarded",
  IN_TRANSIT: "In Transit",
  DELIVERED: "Delivered",
  CLOSED: "Closed",
};

export function LegStatusBadge({ status }: { status: LegStatus }) {
  return <Badge variant={legStatusVariant(status)}>{LEG_LABEL[status]}</Badge>;
}

// Forwarder status (spec §9.1) uses the QuoteStatus vocabulary.
const FORWARDER_LABEL: Record<QuoteStatus, string> = {
  SELECT: "Select",
  RFQ_SENT: "RFQ Sent",
  QUOTED: "Quoted",
  EXPIRED: "Expired",
  INVALID: "Invalid",
  REQUOTED: "Requoted",
  CLOSED: "Closed",
  APPROVED: "Approved",
};

function forwarderVariant(s: QuoteStatus): BadgeVariant {
  switch (s) {
    case "SELECT": return "secondary";
    case "RFQ_SENT": return "accent";
    case "QUOTED":
    case "REQUOTED":
    case "APPROVED": return "success";
    case "EXPIRED":
    case "INVALID": return "destructive";
    default: return "outline";
  }
}

export function ForwarderStatusBadge({ status }: { status: QuoteStatus }) {
  return <Badge variant={forwarderVariant(status)}>{FORWARDER_LABEL[status]}</Badge>;
}
