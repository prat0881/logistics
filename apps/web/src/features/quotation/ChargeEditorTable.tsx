import { useState, type ChangeEvent, type FocusEvent } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import type { PricedGroup, PricedLeg, PricedLine } from "@svyft/shared";
import { Badge } from "@/components/ui/badge";
import { fmtUsd } from "@/features/compare/money";

export interface ChargeEditorTableProps {
  leg: PricedLeg;
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
 * 🔴 Pinning is KEY PRESENCE, never value comparison — the server's own rule (`priceQuotation`
 * derives `overridden` from `key in overrides`, and Task 2's fix round exists precisely to pin the
 * case "a user who types the formula's own number has still pinned that line"). Both the badge and
 * the commit logic here obey it: the badge reads `line.overridden` alone, and a pin is released
 * ONLY by an explicit action — this table's per-line clear button, or the page's "Reset overrides".
 *
 * It used to release a pin whenever the typed value happened to equal `clientAmount(costUsd,
 * marginPct)` (final review IMPORTANT #4). That made the server's pinned-at-the-formula-value state
 * unreachable from the UI, and — much worse — silently UNPINNED a line whose pinned value later
 * coincided with the formula (cost 50, pinned at 60, margin moves to 20%) merely because the user
 * clicked into the field and tabbed out again: the release slipped past the no-op guard, since
 * `undefined !== 60`. Hence `marginPct` is no longer a prop at all — nothing here needs to know
 * the formula, which is the structural guarantee that this can't come back.
 */
export function ChargeEditorTable({ leg, onCommitOverride, readOnly = false }: ChargeEditorTableProps) {
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
  open,
  onToggle,
  onCommitOverride,
  readOnly,
}: {
  legId: string;
  group: PricedGroup;
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
  onCommitOverride,
  readOnly,
}: {
  legId: string;
  line: PricedLine;
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
    const edited = draft !== null;
    setDraft(null);
    // 🔴 An UNTOUCHED field can never commit anything (final review IMPORTANT #4). `draft` is
    // non-null iff a change event has fired on this input, so this is the strongest possible form
    // of the old value-based no-op guard: `userEvent.tab()`, or a click anywhere else on the page,
    // blurs whichever field last had focus, and that blur must be inert. The old guard compared
    // computed values instead, which let a "release the pin" commit (`undefined`) slip through on a
    // line the user had merely clicked into.
    if (!edited) return;
    const parsed = Number(e.currentTarget.value);
    if (!Number.isFinite(parsed)) return;
    // A pin is KEY PRESENCE — a typed value is always an override, even when it equals what the
    // margin formula would have produced anyway (that is a real, server-supported state, and the
    // only way to hold a line steady across a later margin change). Releasing is a separate,
    // explicit act: the clear button below, or the page's "Reset overrides".
    const currentValue = line.overridden ? line.clientUsd : undefined;
    if (parsed === currentValue) return;
    onCommitOverride(legId, line.id, parsed);
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
          <span className="inline-flex items-center justify-end gap-1">
            <input
              type="number"
              step="0.01"
              value={displayValue}
              onChange={onChange}
              onBlur={onBlur}
              aria-label={`${line.label} client price`}
              className="w-28 rounded-md border border-border bg-background px-2 py-1 text-right text-sm"
            />
            {/* The per-line door back to the formula, now that typing the formula's own value no
                longer releases a pin. Without it "Reset overrides" — which clears EVERY pin on the
                whole quotation — would be the only way to undo a single line. */}
            {line.overridden ? (
              <button
                type="button"
                onClick={() => onCommitOverride(legId, line.id, undefined)}
                aria-label={`Clear ${line.label} override`}
                title="Clear override"
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : (
              <span className="inline-block w-[1.625rem]" aria-hidden />
            )}
          </span>
        )}
      </td>
    </tr>
  );
}
