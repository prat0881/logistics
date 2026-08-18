import { useState, type ChangeEvent, type FocusEvent } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { clientAmount, type PricedGroup, type PricedLeg, type PricedLine } from "@svyft/shared";
import { Badge } from "@/components/ui/badge";
import { fmtUsd } from "@/features/compare/money";

export interface ChargeEditorTableProps {
  leg: PricedLeg;
  /** The quotation's current `marginPct` — used only to decide, on blur, whether a typed value
   *  differs from the formula (and so should be sent as an override at all). Never used to
   *  recompute `clientUsd`/`overridden` for display: those always come straight from `leg`. */
  marginPct: number;
  onCommitOverride: (legId: string, lineId: string, value: number | undefined) => void;
  /** S5.8 Task 6, ambiguity resolution #3: once a quotation is ISSUED/SUPERSEDED it "must render
   *  read-only — no margin input, no editable prices" — `QuotationPage` passes `true` for either
   *  status. Every client-price cell renders as plain text (`fmtUsd`) instead of an `<input>`;
   *  `onCommitOverride` is simply never called (no input exists to blur). The "Pinned" badge still
   *  shows — it's a historical fact about how that line was priced, not an editing affordance. */
  readOnly?: boolean;
}

/**
 * ChargeEditorTable — one leg's charge-line editor on the Client Quotation builder (S5.8 Task 5).
 * Groups render collapsed by default, each showing its own rolled-up cost/client totals
 * (ambiguity resolution #1 — with several legs and dozens of lines, an all-expanded screen is
 * unusable); expanding a group reveals its lines, each with the forwarder cost alongside an
 * editable client-price input (resolution #5 — cost is internal context, it never leaves this
 * screen).
 *
 * The "pinned" badge is rendered from `line.overridden` alone (resolution #3) — never from
 * comparing `clientUsd` to `clientAmount(costUsd, marginPct)` here. The server is the source of
 * truth for what counts as pinned (key presence in the overrides map, per Task 2's
 * `priceQuotation`), and a value-comparison badge would be wrong for the (real, tested) case where
 * a user pins a line to the exact value the formula would also have produced.
 */
export function ChargeEditorTable({
  leg,
  marginPct,
  onCommitOverride,
  readOnly = false,
}: ChargeEditorTableProps) {
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

  function toggleGroup(group: string) {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }

  return (
    <div
      data-testid={`charge-editor-${leg.legId}`}
      className="space-y-3 rounded-lg border border-border bg-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="rounded bg-primary/10 px-2 py-0.5 font-mono text-xs font-semibold text-primary">
            {leg.legCode}
          </span>
          <span className="ml-2 text-sm text-muted-foreground">
            {leg.forwarderName}
            {leg.variantLabel ? ` — ${leg.variantLabel}` : ""}
          </span>
        </div>
        <div className="flex gap-6 text-right text-sm">
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Cost</div>
            <div className="text-muted-foreground">{fmtUsd(leg.costUsd)}</div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Client</div>
            <div className="font-semibold">{fmtUsd(leg.clientUsd)}</div>
          </div>
        </div>
      </div>

      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <th className="py-1.5 font-medium">Charge</th>
            <th className="py-1.5 text-right font-medium">Cost (USD)</th>
            <th className="py-1.5 text-right font-medium">Client (USD)</th>
          </tr>
        </thead>
        <tbody>
          {leg.groups.map((group) => (
            <GroupRows
              key={group.group}
              legId={leg.legId}
              group={group}
              marginPct={marginPct}
              open={openGroups.has(group.group)}
              onToggle={() => toggleGroup(group.group)}
              onCommitOverride={onCommitOverride}
              readOnly={readOnly}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GroupRows({
  legId,
  group,
  marginPct,
  open,
  onToggle,
  onCommitOverride,
  readOnly,
}: {
  legId: string;
  group: PricedGroup;
  marginPct: number;
  open: boolean;
  onToggle: () => void;
  onCommitOverride: (legId: string, lineId: string, value: number | undefined) => void;
  readOnly: boolean;
}) {
  return (
    <>
      <tr className="border-b border-border/60">
        <td className="py-1.5">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="flex items-center gap-1.5 font-medium"
          >
            {open ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            {group.label}
          </button>
        </td>
        <td className="py-1.5 text-right text-muted-foreground">{fmtUsd(group.costUsd)}</td>
        <td className="py-1.5 text-right font-medium">{fmtUsd(group.clientUsd)}</td>
      </tr>
      {open &&
        group.lines.map((line) => (
          <LineRow
            key={line.id}
            legId={legId}
            line={line}
            marginPct={marginPct}
            onCommitOverride={onCommitOverride}
            readOnly={readOnly}
          />
        ))}
    </>
  );
}

function LineRow({
  legId,
  line,
  marginPct,
  onCommitOverride,
  readOnly,
}: {
  legId: string;
  line: PricedLine;
  marginPct: number;
  onCommitOverride: (legId: string, lineId: string, value: number | undefined) => void;
  readOnly: boolean;
}) {
  // A genuinely controlled input, not a `key`-reset uncontrolled one: an earlier `key={line.id}-
  // ${line.clientUsd}` approach forced React to unmount/remount this input on every server round
  // trip that changed clientUsd (a PATCH from THIS line, from another line, or a margin change).
  // If the input still had focus when that remount happened — the exact shape of "edit a line,
  // blur, then edit the margin" — removing a focused element fires a browser blur on it first,
  // which re-ran the commit logic a second time against the now-committed value and PATCHed a
  // redundant, identical override. Worse, mid-edit (before the user's own blur), a remount would
  // have silently discarded whatever they were still typing.
  //
  // `draft` is the single source of truth for "am I mid-edit": `null` means "not being typed
  // into right now, trust the server's `line.clientUsd`"; a string means "show exactly what the
  // user has typed, ignore props". This (rather than a separate `useState` + `useEffect` synced
  // from `line.clientUsd`) avoids a real bug that DID surface here: syncing via an effect lags one
  // extra render behind the prop update (the effect runs, calls `setValue`, THEN a second render
  // commits) — so a `getByDisplayValue` assertion taken right after the badge/other props had
  // already updated could still see the OLD input value for one more tick. Deriving the displayed
  // string directly from props during render removes that lag entirely.
  //
  // Plain `String(n)`, not `n.toFixed(2)`: React tracks a controlled `<input type="number">`'s
  // "current" value via the DOM node itself, and after a user types "45", the raw DOM value IS
  // "45". Re-rendering with a cosmetically-reformatted "45.00" is numerically equal, so React's own
  // dirty-check silently skips writing it to the live `.value` property (it still lands in the
  // `value` ATTRIBUTE, which is why the bug was invisible in a debug DOM dump but broke
  // `getByDisplayValue`/anything reading the actual property) — a known footgun specific to
  // number/range inputs. Not reformatting sidesteps it entirely.
  const [draft, setDraft] = useState<string | null>(null);
  const displayValue = draft ?? String(line.clientUsd);

  function onChange(e: ChangeEvent<HTMLInputElement>) {
    setDraft(e.target.value);
  }

  function onBlur(e: FocusEvent<HTMLInputElement>) {
    setDraft(null);
    const parsed = Number(e.currentTarget.value);
    if (!Number.isFinite(parsed)) return;
    const formula = clientAmount(line.costUsd, marginPct);
    // Step 3 of the brief: PATCH it as an override only when it differs from the formula; typing
    // the formula's own value back is how a pin gets released (`undefined` tells the page-level
    // handler to delete this key from the map, not to store a redundant override at it).
    const nextValue = parsed === formula ? undefined : parsed;
    // Skip the round trip entirely when nothing would actually change — `line.overridden`/
    // `clientUsd` are the props' record of what's already committed. Without this guard, tabbing
    // (or even just clicking) through an UNTOUCHED field still fires a full-map PATCH on every
    // blur, since `nextValue` is computed from the formula regardless of whether the value was
    // ever edited. That isn't just wasted traffic: `userEvent.tab()`/a click elsewhere blurs
    // whichever field last had focus, so an edit-then-navigate sequence could fire this on a
    // SIBLING field the user never touched, racing (and clobbering the ordering of) whatever PATCH
    // the user's actual edit already triggered.
    const currentValue = line.overridden ? line.clientUsd : undefined;
    if (nextValue === currentValue) return;
    onCommitOverride(legId, line.id, nextValue);
  }

  return (
    <tr
      data-testid={`line-${legId}-${line.id}`}
      className="border-b border-border/40 last:border-0"
    >
      <td className="py-1.5 pl-5 text-muted-foreground">
        {line.label}
        {line.overridden && (
          <Badge variant="outline" className="ml-2 text-[10px]">
            Pinned
          </Badge>
        )}
      </td>
      <td className="py-1.5 text-right text-muted-foreground">{fmtUsd(line.costUsd)}</td>
      <td className="py-1.5 text-right">
        {readOnly ? (
          <span className="font-medium">{fmtUsd(line.clientUsd)}</span>
        ) : (
          <input
            type="number"
            step="0.01"
            value={displayValue}
            onChange={onChange}
            onBlur={onBlur}
            aria-label={`${line.label} client price`}
            className="w-28 rounded-md border border-border bg-background px-2 py-1 text-right text-sm"
          />
        )}
      </td>
    </tr>
  );
}
