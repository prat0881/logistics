import { useState, type ComponentProps } from "react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FindingsPanel } from "@/components/FindingsPanel";
import { useWizard } from "../../WizardContext";
import { useSaveQuery } from "../../useQueryDetail";
import { useLegs } from "./useLegs";
import { usePoints } from "./usePoints";
import { LegEditor } from "./LegEditor";
import { PointEditor } from "./PointEditor";
import { RouteDiagram } from "./RouteDiagram";
import { useRouteFindings } from "./useRouteFindings";
import type { Finding, FindingScope, QueryDetail, QueryLegDto, QueryPointDto } from "@svyft/shared";

/** Get point name/city for display */
function pointName(
  pointId: string | null | undefined,
  points: QueryPointDto[],
): string {
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

/**
 * RouteSection — the signature RouteDiagram + live isomorphic findings.
 *
 * Split into its own component so `useRouteFindings` (which needs a concrete
 * `QueryDetail`) only mounts once the query exists — before the first save,
 * `LegsStep` shows the "+ Add leg" mint flow instead.
 *
 * The diagram is a pure function of `detail`, so it (and the findings) recompute
 * automatically after every point / leg / cargo mutation refreshes the wizard.
 * Client-side findings are instant; "Validate route" adds the authoritative
 * server pass. Clicking a node/edge cross-highlights the FindingsPanel and vice
 * versa via a shared `selected` scope.
 */
function RouteSection({ detail }: { detail: QueryDetail }) {
  const { all, validateOnServer, validating, serverError } = useRouteFindings(detail);
  const [selected, setSelected] = useState<FindingScope | null>(null);

  const selectedLegId = selected?.type === "leg" ? selected.id ?? null : null;
  const selectedPointId = selected?.type === "point" ? selected.id ?? null : null;

  const onFindingClick = (f: Finding) => setSelected(f.scope);

  return (
    <div className="space-y-3">
      <RouteDiagram
        detail={detail}
        findings={all}
        selectedLegId={selectedLegId}
        selectedPointId={selectedPointId}
        onSelect={setSelected}
      />

      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Live checks run as you build. Validate against the server before you
            create the query.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void validateOnServer()}
            disabled={validating}
          >
            {validating ? "Validating…" : "Validate route"}
          </Button>
        </div>
        {serverError && (
          <p className="text-xs text-destructive">{serverError}</p>
        )}
      </div>

      <FindingsPanel phase="draft" findings={all} onFindingClick={onFindingClick} />
    </div>
  );
}

/**
 * LegsStep — Step 4 body.
 *
 * Displays the leg list from `detail.legs` with:
 *   - legCode (font-mono), mode badge, origin→destination point names
 *   - assigned cargo count
 *   - rollup.totalPackages / totalCbm / totalGrossWt (font-mono tabular-nums)
 *   - status badge
 *   - edit / remove actions
 *
 * "+ Add leg" opens <LegEditor>.
 * Placeholder slots for route diagram (Task 12) and live findings (Task 12).
 */
// Legs step index (0-based) matching STEPS array: client=0, shipment=1, cargo=2, legs=3, notes=4
const LEGS_STEP_INDEX = 3;

export function LegsStep() {
  const { detail, queryId } = useWizard();
  const navigate = useNavigate();
  const { create } = useSaveQuery();

  // Only wire up leg/point mutations when we have a real queryId
  const { remove } = useLegs(queryId ?? "NOOP");
  const { remove: removePoint } = usePoints(queryId ?? "NOOP");

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingLeg, setEditingLeg] = useState<QueryLegDto | undefined>(undefined);
  const [minting, setMinting] = useState(false);
  const [pointEditorOpen, setPointEditorOpen] = useState(false);
  const [editingPoint, setEditingPoint] = useState<QueryPointDto | undefined>(undefined);

  const legs = detail?.legs ?? [];
  const points = detail?.points ?? [];

  const handleRemove = async (legId: string) => {
    if (!queryId) return; // guard: no mutations without a real id
    const ok = window.confirm("Remove this leg?");
    if (!ok) return;
    await remove(legId);
  };

  const handleEdit = (leg: QueryLegDto) => {
    setEditingLeg(leg);
    setEditorOpen(true);
  };

  /**
   * handleAddLeg — spec §5 / §7.4.3: if the query has not been saved yet (isNew),
   * mint it via POST /api/queries first, then navigate to /queries/:id?step=3.
   * The navigation causes WizardProvider to re-render with a real queryId, making
   * LegEditor fully usable. If the query already exists, open the editor directly.
   */
  const handleAddLeg = async () => {
    if (!queryId) {
      // Mint the query (empty body is valid for a DRAFT)
      setMinting(true);
      try {
        const d = await create({});
        navigate(`/queries/${d.id}?step=${LEGS_STEP_INDEX}`, { replace: true });
        // After navigation WizardProvider will have a real queryId — editor can open
        // on the newly-navigated page. We don't set editorOpen here because this
        // component will unmount/remount after navigate.
      } finally {
        setMinting(false);
      }
      return;
    }
    setEditingLeg(undefined);
    setEditorOpen(true);
  };

  const handleEditorSaved = () => {
    setEditorOpen(false);
    setEditingLeg(undefined);
  };

  const handleEditorClose = () => {
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
    if (!queryId) return;
    if (!window.confirm("Remove this point?")) return;
    await removePoint(pointId);
  };

  const handlePointSaved = () => {
    setPointEditorOpen(false);
    setEditingPoint(undefined);
  };

  const handlePointClose = () => {
    setPointEditorOpen(false);
    setEditingPoint(undefined);
  };

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Legs / Route</h2>
        <Button size="sm" onClick={handleAddLeg} disabled={minting}>
          {minting ? "Saving…" : "+ Add leg"}
        </Button>
      </div>

      {/* Signature RouteDiagram + live isomorphic findings (mounted once the
          query exists; the pre-save mint flow lives on "+ Add leg"). */}
      {detail && <RouteSection detail={detail} />}

      {/* Points list (U6) — each point's type + name + address, editable/removable.
          Previously points had no on-screen list and no edit affordance: PointEditor's
          edit mode + usePoints.update existed but were unreachable from the UI, and
          leg rows showed only the point name (never the address). */}
      {detail && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Points</h3>
            {queryId && (
              <Button size="sm" variant="outline" onClick={handleAddPoint}>
                + Add point
              </Button>
            )}
          </div>
          {points.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
              No points yet. Add one here, or via a leg's “+ New point”.
            </div>
          ) : (
            <div className="space-y-2">
              {points.map((pt) => (
                <div
                  key={pt.id}
                  className="rounded-md border p-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex flex-col gap-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="shrink-0 text-xs">
                        {pt.type}
                      </Badge>
                      <span className="text-sm font-medium truncate">{pt.name ?? "—"}</span>
                    </div>
                    <span className="text-xs text-muted-foreground truncate">
                      {pointAddress(pt)}
                    </span>
                  </div>
                  {queryId && (
                    <div className="flex gap-1 shrink-0">
                      <Button variant="outline" size="sm" onClick={() => handleEditPoint(pt)}>
                        Edit
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleRemovePoint(pt.id)}
                      >
                        Remove
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Leg list */}
      {legs.length === 0 ? (
        <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
          Add the first leg to build the route.
        </div>
      ) : (
        <div className="space-y-2">
          {legs.map((leg) => {
            const originName = pointName(leg.originPointId, points);
            const destName = pointName(leg.destinationPointId, points);
            const cargoCount = leg.assignedCargoIds.length;
            const rollup = leg.rollup;

            return (
              <div
                key={leg.id}
                className="rounded-md border p-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
              >
                {/* Left side: leg info */}
                <div className="flex flex-wrap items-center gap-2 flex-1 min-w-0">
                  {/* Leg code */}
                  <span className="font-mono text-sm font-semibold shrink-0">
                    {leg.legCode}
                  </span>

                  {/* Mode badge */}
                  {leg.mode && (
                    <Badge variant="outline" className="shrink-0 text-xs">
                      {leg.mode}
                    </Badge>
                  )}

                  {/* Origin → Destination */}
                  <span className="text-sm truncate">
                    <span>{originName}</span>
                    <span className="mx-1 text-muted-foreground">→</span>
                    <span>{destName}</span>
                  </span>

                  {/* Status */}
                  <Badge
                    variant={leg.status === "READY_FOR_RFQ" ? "success" : "secondary"}
                    className="shrink-0 text-xs"
                  >
                    {leg.status}
                  </Badge>
                </div>

                {/* Right side: metrics + actions */}
                <div className="flex flex-wrap items-center gap-3 shrink-0">
                  {/* Cargo count */}
                  <span className="text-xs text-muted-foreground">
                    {cargoCount} cargo
                  </span>

                  {/* Rollup metrics */}
                  <span className="font-mono tabular-nums text-xs text-muted-foreground">
                    {rollup.totalPackages} pkg
                  </span>
                  <span className="font-mono tabular-nums text-xs text-muted-foreground">
                    {fmtNum(rollup.totalCbm, 4)} CBM
                  </span>
                  <span className="font-mono tabular-nums text-xs text-muted-foreground">
                    {fmtNum(rollup.totalGrossWt, 2)} kg
                  </span>

                  {/* Actions */}
                  <div className="flex gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleEdit(leg)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => handleRemove(leg.id)}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* LegEditor dialog — only mounted when we have a real queryId and detail */}
      {detail && queryId && (
        <LegEditor
          open={editorOpen}
          leg={editingLeg}
          detail={detail}
          queryId={queryId}
          onSaved={handleEditorSaved}
          onClose={handleEditorClose}
        />
      )}

      {/* PointEditor dialog (U6) — create or edit a point directly from the list.
          Keyed on the point id so the form re-initialises when switching points. */}
      {detail && queryId && (
        <PointEditor
          key={editingPoint?.id ?? "new-point"}
          queryId={queryId}
          open={pointEditorOpen}
          point={editingPoint as unknown as ComponentProps<typeof PointEditor>["point"]}
          onSaved={handlePointSaved}
          onClose={handlePointClose}
        />
      )}
    </div>
  );
}
