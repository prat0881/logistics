import { Button } from "@/components/ui/button";
import { useReissueToken } from "./useRfq";
import { PortalLinkRow } from "./PortalLinkRow";

export function RegeneratePortalLink({ queryId, freightForwarderId }: { queryId: string; freightForwarderId: string }) {
  const reissue = useReissueToken(queryId);
  const token = reissue.data?.accessToken;
  return (
    <div className="space-y-1">
      <Button type="button" variant="outline" size="sm"
        disabled={reissue.isPending}
        onClick={() => reissue.mutate(freightForwarderId)}>
        {reissue.isPending ? "Regenerating…" : "Regenerate portal link"}
      </Button>
      {token && (
        <>
          <PortalLinkRow url={`${window.location.origin}/ff/rfq/${token}`} />
          <p className="text-xs text-muted-foreground">This invalidates the previous link.</p>
        </>
      )}
      {reissue.isError && <p className="text-xs text-destructive">Couldn't regenerate the link. Try again.</p>}
    </div>
  );
}
