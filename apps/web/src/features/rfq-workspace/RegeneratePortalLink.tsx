import { useState } from "react";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";
import { useReissueToken } from "./useRfq";
import { PortalLinkRow } from "./PortalLinkRow";

/**
 * Compact "Regenerate" control for a frozen (distributed) FF. On success it rotates
 * the RFQ access token, copies the new portal link to the clipboard, and shows a
 * transient ~2s confirmation (plus an aria-live status). NOTE (S4.3 tradeoff,
 * user-accepted): on the happy path the regenerated link is NOT rendered as
 * selectable text here — only copied. (The full link is still shown at distribution
 * time in DistributeLegAction via PortalLinkRow, so discoverability is preserved
 * there.) If the clipboard write itself fails, the previous link has already been
 * invalidated by the reissue, so we fall back to rendering PortalLinkRow inline
 * here too — otherwise the user would be stranded with no way to get the new link.
 */
export function RegeneratePortalLink({ queryId, freightForwarderId }: { queryId: string; freightForwarderId: string }) {
  const reissue = useReissueToken(queryId);
  const [copied, setCopied] = useState(false);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);

  function regenerate() {
    reissue.mutate(freightForwarderId, {
      onSuccess: async (res) => {
        const url = `${window.location.origin}/ff/rfq/${res.accessToken}`;
        // Clear any stale confirmation/fallback from a previous attempt before this
        // one resolves. Without this, a repeat click within the prior 2s window
        // whose copy fails would render the new fallback link while the old
        // "Link copied ✓" state was still up (its clear-timer hadn't fired yet),
        // showing a stale confirmation next to a now-invalid link.
        setCopied(false);
        setFallbackUrl(null);
        const ok = await copyToClipboard(url);
        if (ok) {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        } else {
          setFallbackUrl(url);
        }
      },
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={reissue.isPending} onClick={regenerate}>
          {reissue.isPending ? "Regenerating…" : copied ? "Link copied ✓" : "Regenerate"}
        </Button>
        <span aria-live="polite" className="sr-only">
          {copied
            ? "Copied the new portal link to your clipboard. The previous link is now invalid."
            : fallbackUrl
              ? "Couldn't copy the new portal link automatically. The previous link is now invalid — copy the link shown below."
              : ""}
        </span>
        {reissue.isError && <span className="text-xs text-destructive">Couldn't regenerate. Try again.</span>}
      </div>
      {fallbackUrl && (
        <div className="space-y-1">
          <p className="text-xs text-warning">Couldn't copy automatically — copy the link below.</p>
          <PortalLinkRow key={fallbackUrl} url={fallbackUrl} />
        </div>
      )}
    </div>
  );
}
