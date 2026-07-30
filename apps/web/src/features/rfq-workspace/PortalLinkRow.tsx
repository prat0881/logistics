import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";

export function PortalLinkRow({ url }: { url: string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  async function copy() {
    setState((await copyToClipboard(url)) ? "ok" : "fail");
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Input
          aria-label="Portal link"
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="font-mono text-xs"
        />
        <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
          Copy
        </Button>
      </div>
      {state === "ok" && <p className="text-xs text-success">Copied ✓</p>}
      {state === "fail" && <p className="text-xs text-warning">Couldn't copy — select the link above</p>}
    </div>
  );
}
