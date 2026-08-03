import { useEffect, useState, type ComponentProps } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useWizard } from "../../WizardContext";
import { useSaveQuery } from "../../useQueryDetail";
import type { StepSaveFn } from "../Step1Client";
import { LegEditor } from "./LegEditor";
import { PointEditor } from "./PointEditor";
import { RouteDiagram } from "./RouteDiagram";
import type { QueryDetail, QueryLegDto, QueryPointDto } from "@svyft/shared";

// Legs step index (0-based) matching STEPS array: client=0, shipment=1, cargo=2, legs=3, notes=4
const LEGS_STEP_INDEX = 3;

/**
 * LegsStepBody — Step 4 content once the query exists (detail is guaranteed).
 *
 * Layout (top→bottom): toolbar (+ Add point · + Add leg) · RouteDiagram (the
 * primary surface — click a point box or leg edge to edit) · LegEditor +
 * PointEditor dialogs. Route/leg validation is Create-only (S3.6/S3.8): no
 * page banners, no pre-Create live checks here. The Create Query gate runs
 * `validateRoute`, and its findings render in the shell-level
 * ValidationSummary at the top of every step (WizardShell) — that behaviour
 * is untouched.
 *
 * The `?add=point|leg` search param minted by the pre-mint wrapper is consumed
 * here on mount: opens the corresponding editor, then clears the param so a
 * page refresh doesn't re-open it.
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
  const [searchParams, setSearchParams] = useSearchParams();

  // Legs/points persist eagerly; nothing to save here, and validation is Create-only now.
  useEffect(() => {
    registerSave(() => Promise.resolve(undefined));
  }, [registerSave]);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingLeg, setEditingLeg] = useState<QueryLegDto | undefined>(undefined);
  const [pointEditorOpen, setPointEditorOpen] = useState(false);
  const [editingPoint, setEditingPoint] = useState<QueryPointDto | undefined>(undefined);

  const handleAddLeg = () => {
    setEditingLeg(undefined);
    setEditorOpen(true);
  };
  const handleEdit = (leg: QueryLegDto) => {
    setEditingLeg(leg);
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
  const closePointEditor = () => {
    setPointEditorOpen(false);
    setEditingPoint(undefined);
  };

  // Consume the ?add= param minted by the pre-mint wrapper. Run on mount only
  // (intentional empty dep array — we snapshot the param once and clear it).
  useEffect(() => {
    const add = searchParams.get("add");
    if (add === "point") handleAddPoint();
    else if (add === "leg") handleAddLeg();
    if (add) {
      const next = new URLSearchParams(searchParams);
      next.delete("add");
      setSearchParams(next, { replace: true });
    }
  }, []); // intentional: mount-only

  return (
    <div className="space-y-4 p-4">
      <h2 className="text-base font-semibold">Leg & Route</h2>

      {/* Toolbar */}
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={handleAddPoint}>
          + Add point
        </Button>
        <Button size="sm" onClick={handleAddLeg}>
          + Add leg
        </Button>
      </div>

      {/* Route diagram — the primary editing surface. No live findings passed:
          route validation runs only at Create Query (shell ValidationSummary). */}
      <RouteDiagram
        detail={detail}
        findings={[]}
        onEditPoint={(id) => {
          const pt = detail.points.find((p) => p.id === id);
          if (pt) handleEditPoint(pt);
        }}
        onEditLeg={(id) => {
          const leg = detail.legs.find((l) => l.id === id);
          if (leg) handleEdit(leg);
        }}
      />

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
        legs={detail.legs}
        onSaved={closePointEditor}
        onClose={closePointEditor}
      />
    </div>
  );
}

/**
 * LegsStep — Step 4. Thin wrapper: before the query is minted (new query) it shows
 * the same "+ Add point" / "+ Add leg" toolbar; each button mints the query then
 * navigates with `?add=point|leg` so `LegsStepBody` opens the right editor on load.
 *
 * §5 / §7.4.3: the first persist mints the query — here a toolbar button on a
 * brand-new query POSTs an empty DRAFT then navigates to /queries/:id?step=3&add=…,
 * which re-renders with a real queryId and opens the editor.
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

  const handleMintAdd = async (what: "point" | "leg") => {
    setMinting(true);
    try {
      const d = await create({});
      navigate(`/queries/${d.id}?step=${LEGS_STEP_INDEX}&add=${what}`, { replace: true });
    } finally {
      setMinting(false);
    }
  };

  return (
    <div className="space-y-4 p-4">
      <h2 className="text-base font-semibold">Leg & Route</h2>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => handleMintAdd("point")}
          disabled={minting}
        >
          {minting ? "Saving…" : "+ Add point"}
        </Button>
        <Button size="sm" onClick={() => handleMintAdd("leg")} disabled={minting}>
          {minting ? "Saving…" : "+ Add leg"}
        </Button>
      </div>
      <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
        Add the first leg to build the route.
      </div>
    </div>
  );
}
