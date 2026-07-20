import { useEffect, useState, type ComponentProps } from "react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useWizard } from "../../WizardContext";
import { useSaveQuery } from "../../useQueryDetail";
import type { StepSaveFn } from "../Step1Client";
import { useLegs } from "./useLegs";
import { usePoints } from "./usePoints";
import { LegEditor } from "./LegEditor";
import { PointEditor } from "./PointEditor";
import { RouteDiagram } from "./RouteDiagram";
import { useRouteFindings, type GroupedFindings } from "./useRouteFindings";
import type { FindingScope, QueryDetail, QueryLegDto, QueryPointDto } from "@svyft/shared";

// Legs step index (0-based) matching STEPS array: client=0, shipment=1, cargo=2, legs=3, notes=4
const LEGS_STEP_INDEX = 3;

/** Get point name/city for display */
function pointName(pointId: string | null | undefined, points: QueryPointDto[]): string {
  if (!pointId) return "—";
  const p = points.find((pt) => pt.id === pointId);
  return p?.name ?? p?.city ?? pointId;
}

/** Format a number for tabular display */
function fmtNum(n: number, decimals = 2): string {
  return n.toFixed(decimals);
}

/** Compact one-line address/identity for a point row (U6). */
function pointAddress(p: QueryPointDto): string {
  const code = p.iataCode ?? p.unLocode ?? p.icaoCode ?? null;
  const parts = [code, p.streetAddress, p.city, p.postalCode, p.country].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No address yet";
}

/** Small inline "⚠ N" indicator shown on a box that has route findings. */
function WarningBadge({ count }: { count: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-sm bg-destructive/10 px-1.5 py-0.5 text-xs font-medium text-destructive">
      ⚠ {count}
    </span>
  );
}

/**
 * RouteNoticesStrip — the top summary strip (replaces the old FindingsPanel list).
 * Shows a one-line count + the query-scoped findings that don't map to a single box
 * (e.g. "At least one Pickup point is required"). Per-box detail lives on hover.
 */
function RouteNoticesStrip({ grouped }: { grouped: GroupedFindings }) {
  if (grouped.blocking.length === 0) return null;
  const n = grouped.blocking.length;
  return (
    <div
      role="alert"
      className="space-y-1 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
    >
      <p className="font-medium">
        ⚠ {n} issue{n === 1 ? "" : "s"} to resolve — hover the highlighted boxes for details.
      </p>
      {grouped.queryScoped.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5">
          {grouped.queryScoped.map((f, i) => (
            <li key={i}>
              <span className="mr-1 font-mono text-xs">{f.rule}</span>
              {f.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * LegsStepBody — Step 4 content once the query exists (detail is guaranteed).
 *
 * Layout (top→bottom): notices strip · Points · Legs · Route diagram. Findings run
 * live at create-phase (`useRouteFindings`); the top strip carries the summary +
 * query-scoped findings, and each Point/Leg card shows a ⚠ badge + hover tooltip
 * for the findings on that box. The "Validate route" button is gone — validation
 * runs on Save/Next (the Next-gate lives in the wizard shell).
 */
function LegsStepBody({
  detail,
  queryId,
  registerSave,
}: {
  detail: QueryDetail;
  queryId: string;
  registerSave: (fn: StepSaveFn) => void;
}) {
  const { remove } = useLegs(queryId);
  const { remove: removePoint } = usePoints(queryId);
  const { all, grouped, validateOnServer } = useRouteFindings(detail);
  const [selected, setSelected] = useState<FindingScope | null>(null);

  // Next-gate (#3): Save/Next run the authoritative server validate; Next blocks
  // advancing when any create-phase route finding is blocking. Save still resolves —
  // legs/points persist eagerly, so there is nothing to write from here.
  useEffect(() => {
    registerSave(async (opts) => {
      const serverFindings = await validateOnServer();
      if (opts?.enforceRequired) {
        const blocked =
          serverFindings.some((f) => f.severity === "blocking") || grouped.blocking.length > 0;
        if (blocked) {
          throw new Error("Resolve the route issues on this screen before continuing.");
        }
      }
      return undefined;
    });
  }, [registerSave, validateOnServer, grouped]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingLeg, setEditingLeg] = useState<QueryLegDto | undefined>(undefined);
  const [pointEditorOpen, setPointEditorOpen] = useState(false);
  const [editingPoint, setEditingPoint] = useState<QueryPointDto | undefined>(undefined);

  const legs = detail.legs;
  const points = detail.points;

  const selectedLegId = selected?.type === "leg" ? selected.id ?? null : null;
  const selectedPointId = selected?.type === "point" ? selected.id ?? null : null;

  const handleRemove = async (legId: string) => {
    if (!window.confirm("Remove this leg?")) return;
    await remove(legId);
  };
  const handleEdit = (leg: QueryLegDto) => {
    setEditingLeg(leg);
    setEditorOpen(true);
  };
  const handleAddLeg = () => {
    setEditingLeg(undefined);
    setEditorOpen(true);
  };
  const closeLegEditor = () => {
    setEditorOpen(false);
    setEditingLeg(undefined);
  };

  const handleAddPoint = () => {
    setEditingPoint(undefined);
    setPointEditorOpen(true);
  };
  const handleEditPoint = (pt: QueryPointDto) => {
    setEditingPoint(pt);
    setPointEditorOpen(true);
  };
  const handleRemovePoint = async (pointId: string) => {
    if (!window.confirm("Remove this point?")) return;
    await removePoint(pointId);
  };
  const closePointEditor = () => {
    setPointEditorOpen(false);
    setEditingPoint(undefined);
  };

  return (
    <div className="space-y-4 p-4">
      {/* Notices strip (top) */}
      <RouteNoticesStrip grouped={grouped} />

      {/* Points */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Points</h3>
          <Button size="sm" variant="outline" onClick={handleAddPoint}>
            + Add point
          </Button>
        </div>
        {points.length === 0 ? (
          <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
            No points yet. Add one here, or via a leg's “+ New point”.
          </div>
        ) : (
          <div className="space-y-2">
            {points.map((pt) => {
              const pf = grouped.byPoint.get(pt.id) ?? [];
              const hasErr = pf.length > 0;
              return (
                <div
                  key={pt.id}
                  title={hasErr ? pf.map((f) => f.message).join("\n") : undefined}
                  className={`rounded-md border p-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between ${
                    hasErr ? "border-destructive" : ""
                  }`}
                >
                  <div className="flex flex-col gap-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="shrink-0 text-xs">
                        {pt.type}
                      </Badge>
                      <span className="text-sm font-medium truncate">{pt.name ?? "—"}</span>
                      {hasErr && <WarningBadge count={pf.length} />}
                    </div>
                    <span className="text-xs text-muted-foreground truncate">
                      {pointAddress(pt)}
                    </span>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button variant="outline" size="sm" onClick={() => handleEditPoint(pt)}>
                      Edit
                    </Button>
                    <Button variant="destructive" size="sm" onClick={() => handleRemovePoint(pt.id)}>
                      Remove
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Legs */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Legs</h3>
          <Button size="sm" onClick={handleAddLeg}>
            + Add leg
          </Button>
        </div>
        {legs.length === 0 ? (
          <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
            Add the first leg to build the route.
          </div>
        ) : (
          <div className="space-y-2">
            {legs.map((leg) => {
              const lf = grouped.byLeg.get(leg.id) ?? [];
              const hasErr = lf.length > 0;
              const originName = pointName(leg.originPointId, points);
              const destName = pointName(leg.destinationPointId, points);
              const cargoCount = leg.assignedCargoIds.length;
              const rollup = leg.rollup;

              return (
                <div
                  key={leg.id}
                  title={hasErr ? lf.map((f) => f.message).join("\n") : undefined}
                  className={`rounded-md border p-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between ${
                    hasErr ? "border-destructive" : ""
                  }`}
                >
                  {/* Left side: leg info */}
                  <div className="flex flex-wrap items-center gap-2 flex-1 min-w-0">
                    <span className="font-mono text-sm font-semibold shrink-0">{leg.legCode}</span>
                    {leg.mode && (
                      <Badge variant="outline" className="shrink-0 text-xs">
                        {leg.mode}
                      </Badge>
                    )}
                    <span className="text-sm truncate">
                      <span>{originName}</span>
                      <span className="mx-1 text-muted-foreground">→</span>
                      <span>{destName}</span>
                    </span>
                    <Badge
                      variant={leg.status === "READY_FOR_RFQ" ? "success" : "secondary"}
                      className="shrink-0 text-xs"
                    >
                      {leg.status}
                    </Badge>
                    {hasErr && <WarningBadge count={lf.length} />}
                  </div>

                  {/* Right side: metrics + actions */}
                  <div className="flex flex-wrap items-center gap-3 shrink-0">
                    <span className="text-xs text-muted-foreground">{cargoCount} cargo</span>
                    <span className="font-mono tabular-nums text-xs text-muted-foreground">
                      {rollup.totalPackages} pkg
                    </span>
                    <span className="font-mono tabular-nums text-xs text-muted-foreground">
                      {fmtNum(rollup.totalCbm, 4)} CBM
                    </span>
                    <span className="font-mono tabular-nums text-xs text-muted-foreground">
                      {fmtNum(rollup.totalGrossWt, 2)} kg
                    </span>
                    <div className="flex gap-1">
                      <Button variant="outline" size="sm" onClick={() => handleEdit(leg)}>
                        Edit
                      </Button>
                      <Button variant="destructive" size="sm" onClick={() => handleRemove(leg.id)}>
                        Remove
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Route diagram (bottom) — the signature SVG; findings cross-highlight on click. */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Route</h3>
        <RouteDiagram
          detail={detail}
          findings={all}
          selectedLegId={selectedLegId}
          selectedPointId={selectedPointId}
          onSelect={setSelected}
        />
      </section>

      {/* LegEditor dialog */}
      <LegEditor
        open={editorOpen}
        leg={editingLeg}
        detail={detail}
        queryId={queryId}
        onSaved={closeLegEditor}
        onClose={closeLegEditor}
      />

      {/* PointEditor dialog (U6) — keyed on the point id so the form re-initialises. */}
      <PointEditor
        key={editingPoint?.id ?? "new-point"}
        queryId={queryId}
        open={pointEditorOpen}
        point={editingPoint as unknown as ComponentProps<typeof PointEditor>["point"]}
        onSaved={closePointEditor}
        onClose={closePointEditor}
      />
    </div>
  );
}

/**
 * LegsStep — Step 4. Thin wrapper: before the query is minted (new query) it shows
 * the "+ Add leg" mint entry point; once `detail` exists it renders LegsStepBody
 * (which owns the findings feed + all the point/leg UI).
 *
 * §5 / §7.4.3: the first persist mints the query — here "+ Add leg" on a brand-new
 * query POSTs an empty DRAFT then navigates to /queries/:id?step=3, which re-renders
 * with a real queryId.
 */
export function LegsStep({ registerSave }: { registerSave: (fn: StepSaveFn) => void }) {
  const { detail, queryId } = useWizard();
  const navigate = useNavigate();
  const { create } = useSaveQuery();
  const [minting, setMinting] = useState(false);

  const hasBody = Boolean(detail && queryId);
  // Pre-mint / loading: register a no-op so the shell's Save/Next don't invoke a
  // stale step fn. Once detail exists, LegsStepBody registers the real Next-gate.
  useEffect(() => {
    if (!hasBody) registerSave(() => Promise.resolve());
  }, [hasBody, registerSave]);

  if (detail && queryId) {
    return <LegsStepBody detail={detail} queryId={queryId} registerSave={registerSave} />;
  }

  const handleMint = async () => {
    setMinting(true);
    try {
      const d = await create({});
      navigate(`/queries/${d.id}?step=${LEGS_STEP_INDEX}`, { replace: true });
    } finally {
      setMinting(false);
    }
  };

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Legs / Route</h2>
        <Button size="sm" onClick={handleMint} disabled={minting}>
          {minting ? "Saving…" : "+ Add leg"}
        </Button>
      </div>
      <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
        Add the first leg to build the route.
      </div>
    </div>
  );
}
