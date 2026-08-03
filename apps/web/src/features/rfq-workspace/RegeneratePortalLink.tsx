import { useState } from "react";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";
import { useReissueToken } from "./useRfq";

/**
 * Compact "Regenerate" control for a frozen (distributed) FF. On success it rotates
 * the RFQ access token, copies the new portal link to the clipboard, and shows a
 * transient ~2s confirmation (plus an aria-live status). NOTE (S4.3 tradeoff,
 * user-accepted): the regenerated link is NOT rendered as selectable text here —
 * only copied. The full link is still shown at distribution time in
 * DistributeLegAction (PortalLinkRow), so discoverability is preserved there.
 */
export function RegeneratePortalLink({ queryId, freightForwarderId }: { queryId: string; freightForwarderId: string }) {
  const reissue = useReissueToken(queryId);
  const [copied, setCopied] = useState(false);

  function regenerate() {
    reissue.mutate(freightForwarderId, {
      onSuccess: async (res) => {
        await copyToClipboard(`${window.location.origin}/ff/rfq/${res.accessToken}`);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      },
    });
  }

  return (
    <div className="flex items-center gap-2">
      <Button type="button" variant="outline" size="sm" disabled={reissue.isPending} onClick={regenerate}>
        {reissue.isPending ? "Regenerating…" : copied ? "Link copied ✓" : "Regenerate"}
      </Button>
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied the new portal link to your clipboard. The previous link is now invalid." : ""}
      </span>
      {reissue.isError && <span className="text-xs text-destructive">Couldn't regenerate. Try again.</span>}
    </div>
  );
}
