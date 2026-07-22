import { useMemo, useState } from "react";
import {
  FreightMode,
  PointType,
  type Finding,
  type FindingScope,
  type QueryDetail,
} from "@svyft/shared";
import { cn } from "@/lib/utils";
import { toRouteGraph } from "./routeGraph";

/**
 * RouteDiagram — the product's signature element (Task 1 design language).
 *
 * A query *is* a path through ports, so we render it as a literal node-graph:
 * port nodes wired left-to-right by mode-typed leg edges, read like a
 * bill-of-lading routing table drawn as an instrument schematic. The field is
 * kept quiet (cobalt/graphite) so the ONE bold thing — the marigold `--accent`
 * on the active/selected leg + its nodes — reads as the live signal.
 *
 * It is a visualization + validation aid, not an input surface: clicking a node
 * or edge fires `onSelect(scope)` to cross-highlight the FindingsPanel.
 *
 * Pure function of `detail` + `findings`, so it redraws automatically whenever
 * the wizard refreshes the query graph after any point/leg/cargo mutation.
 */

// ── layout constants (SVG user units) ────────────────────────────────────────
const NODE_W = 168;
const NODE_H = 64;
const COL_GAP = 96; // horizontal gap between depth columns
const ROW_GAP = 28; // vertical gap between nodes sharing a depth
const PAD = 24; // viewBox padding
const LEGEND_H = 34;

type Highlight = { finding: "blocking" | "warning" | null };

interface RouteDiagramProps {
  detail: QueryDetail;
  findings: Finding[];
  /** The leg the user is focused on — rendered with the marigold accent. */
  selectedLegId?: string | null;
  /** The point the user is focused on — rendered with the marigold accent. */
  selectedPointId?: string | null;
  onSelect?: (scope: FindingScope) => void;
  /** Task 2: preferred handler — clicking a point node opens the point editor. */
  onEditPoint?: (pointId: string) => void;
  /** Task 2: preferred handler — clicking a leg edge opens the leg editor. */
  onEditLeg?: (legId: string) => void;
  className?: string;
}

/** A short human glyph + label per point type (drawn as SVG, print-clean). */
const POINT_GLYPH: Record<string, { glyph: string; label: string }> = {
  [PointType.PICKUP]: { glyph: "▲", label: "Pickup" },
  [PointType.DELIVERY]: { glyph: "◆", label: "Delivery" },
  [PointType.WAREHOUSE]: { glyph: "▣", label: "Warehouse" },
  [PointType.AIRPORT]: { glyph: "✈", label: "Airport" },
  [PointType.SEAPORT]: { glyph: "⚓", label: "Seaport" },
};

/** CSS custom-property color per freight mode (themeable, see index.css). */
function modeColor(mode: FreightMode | null): string {
  if (mode === FreightMode.SEA) return "hsl(var(--mode-sea))";
  if (mode === FreightMode.AIR) return "hsl(var(--mode-air))";
  if (mode === FreightMode.ROAD) return "hsl(var(--mode-road))";
  return "hsl(var(--muted-foreground))"; // no mode chosen yet
}

/** Dash pattern encodes the mode as a redundant, colorblind-safe channel. */
function modeDash(mode: FreightMode | null): string | undefined {
  if (mode === FreightMode.SEA) return "10 6"; // wake
  if (mode === FreightMode.AIR) return "2 6"; // flight path (dotted)
  return undefined; // ROAD / unset = solid
}

const MODES: FreightMode[] = [FreightMode.ROAD, FreightMode.SEA, FreightMode.AIR];

export function RouteDiagram({
  detail,
  findings,
  selectedLegId,
  selectedPointId,
  onSelect,
  onEditPoint,
  onEditLeg,
  className,
}: RouteDiagramProps) {
  const [hovered, setHovered] = useState<{ kind: "point" | "leg"; id: string } | null>(null);

  const graph = useMemo(() => toRouteGraph(detail), [detail]);

  const layout = useMemo(() => computeLayout(graph), [graph]);

  // Resolve findings → per-point / per-leg highlight severity.
  const highlights = useMemo(
    () => resolveHighlights(graph, findings),
    [graph, findings],
  );

  const prefersReducedMotion = useMemo(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  const hasLegs = graph.legs.length > 0;
  const hasPoints = graph.points.length > 0;

  // Render the canvas whenever there is anything to draw. A points-only graph
  // (added points, no legs yet) draws the boxes so the user can wire them.
  if (!hasLegs && !hasPoints) {
    return (
      <div
        data-slot="route-diagram"
        className={cn(
          "rounded-md border border-dashed bg-card p-8 text-center text-sm text-muted-foreground",
          className,
        )}
      >
        Add a point or leg to start the route.
      </div>
    );
  }

  const { width, height, pos } = layout;
  const svgHeight = height + LEGEND_H;

  return (
    <figure
      data-slot="route-diagram"
      className={cn(
        "relative overflow-x-auto rounded-md border bg-card p-3",
        className,
      )}
      aria-label="Route diagram"
    >
      <figcaption className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Route
        </span>
        <Legend />
      </figcaption>

      <svg
        role="img"
        aria-label="Route as a node graph — port nodes wired by leg edges"
        width={width}
        height={svgHeight}
        viewBox={`0 0 ${width} ${svgHeight}`}
        className="max-w-full"
        style={{ minWidth: Math.min(width, 320) }}
      >
        <defs>
          {/* One arrowhead marker per mode color + the highlight variants. */}
          {MODES.map((m) => (
            <Arrow key={m} id={`arrow-${m}`} color={modeColor(m)} />
          ))}
          <Arrow id="arrow-unset" color="hsl(var(--muted-foreground))" />
          <Arrow id="arrow-blocking" color="hsl(var(--destructive))" />
          <Arrow id="arrow-warning" color="hsl(var(--warning))" />
          <Arrow id="arrow-active" color="hsl(var(--accent))" />
        </defs>

        {/* Edges first, so nodes paint on top. */}
        <g>
          {graph.legs.map((leg) => {
            const o = leg.originPointId ? pos.get(leg.originPointId) : undefined;
            const d = leg.destinationPointId
              ? pos.get(leg.destinationPointId)
              : undefined;
            if (!o || !d) return null; // incomplete leg — C1 flags it in the panel
            const hl = highlights.legs.get(leg.id) ?? { finding: null };
            const active = selectedLegId === leg.id;
            return (
              <Edge
                key={leg.id}
                leg={leg}
                from={o}
                to={d}
                highlight={hl}
                messages={highlights.legMsgs.get(leg.id) ?? []}
                active={active}
                reducedMotion={prefersReducedMotion}
                onSelect={onSelect}
                onEditLeg={onEditLeg}
                onHover={() => setHovered({ kind: "leg", id: leg.id })}
                onLeave={() => setHovered(null)}
              />
            );
          })}
        </g>

        {/* Nodes. */}
        <g>
          {graph.points.map((p) => {
            const at = pos.get(p.id);
            if (!at) return null;
            const hl = highlights.points.get(p.id) ?? { finding: null };
            const orphan = highlights.orphans.has(p.id);
            const active = selectedPointId === p.id;
            return (
              <Node
                key={p.id}
                point={p}
                x={at.x}
                y={at.y}
                highlight={hl}
                messages={highlights.pointMsgs.get(p.id) ?? []}
                orphan={orphan}
                active={active}
                reducedMotion={prefersReducedMotion}
                onSelect={onSelect}
                onEditPoint={onEditPoint}
                onHover={() => setHovered({ kind: "point", id: p.id })}
                onLeave={() => setHovered(null)}
              />
            );
          })}
        </g>
      </svg>

      {hovered && (
        <RouteTooltip
          detail={detail}
          hovered={hovered}
          pos={pos}
          pointMsgs={highlights.pointMsgs}
          legMsgs={highlights.legMsgs}
        />
      )}
    </figure>
  );
}

// ── edge ─────────────────────────────────────────────────────────────────────

interface Pt {
  x: number;
  y: number;
}

function Edge({
  leg,
  from,
  to,
  highlight,
  messages,
  active,
  reducedMotion,
  onSelect,
  onEditLeg,
  onHover,
  onLeave,
}: {
  leg: ReturnType<typeof toRouteGraph>["legs"][number];
  from: Pt;
  to: Pt;
  highlight: Highlight;
  messages: string[];
  active: boolean;
  reducedMotion: boolean;
  onSelect?: (scope: FindingScope) => void;
  onEditLeg?: (legId: string) => void;
  onHover?: () => void;
  onLeave?: () => void;
}) {
  // Anchor at the right edge of origin node and left edge of destination node.
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;

  // A gentle cubic so same-column / back-references don't overlap the nodes.
  const dx = Math.max(40, (x2 - x1) / 2);
  const path = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;

  // Highlight precedence: blocking > active > warning > mode default.
  let stroke = modeColor(leg.mode);
  let markerId = leg.mode ? `arrow-${leg.mode}` : "arrow-unset";
  let width = 2.25;
  if (highlight.finding === "warning") {
    stroke = "hsl(var(--warning))";
    markerId = "arrow-warning";
    width = 2.75;
  }
  if (active) {
    stroke = "hsl(var(--accent))";
    markerId = "arrow-active";
    width = 3.25;
  }
  if (highlight.finding === "blocking") {
    stroke = "hsl(var(--destructive))";
    markerId = "arrow-blocking";
    width = 3;
  }

  const mid = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
  const dash = modeDash(leg.mode);

  const activate = () =>
    onEditLeg ? onEditLeg(leg.id) : onSelect?.({ type: "leg", id: leg.id });
  const interactive = !!onEditLeg || !!onSelect;

  return (
    <g
      data-leg-id={leg.id}
      data-mode={leg.mode ?? "NONE"}
      data-active={active ? "true" : undefined}
      data-finding={highlight.finding ?? undefined}
      className={cn("group", interactive && "route-focusable cursor-pointer")}
      onClick={interactive ? activate : undefined}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                activate();
              }
            }
          : undefined
      }
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      onFocus={onHover}
      onBlur={onLeave}
      aria-label={`Leg ${leg.legCode}${leg.mode ? ` (${leg.mode})` : ""}`}
    >
      {messages.length > 0 && <title>{messages.join("\n")}</title>}
      {/* Fat invisible hit-target so thin edges are easy to click. */}
      <path d={path} stroke="transparent" strokeWidth={16} fill="none" />
      {/* Blocking edges get a soft destructive halo. */}
      {highlight.finding === "blocking" && (
        <path
          d={path}
          stroke="hsl(var(--destructive))"
          strokeOpacity={0.18}
          strokeWidth={width + 6}
          fill="none"
          strokeLinecap="round"
        />
      )}
      {active && (
        <path
          d={path}
          stroke="hsl(var(--accent))"
          strokeOpacity={0.16}
          strokeWidth={width + 6}
          fill="none"
          strokeLinecap="round"
        />
      )}
      <path
        d={path}
        stroke={stroke}
        strokeWidth={width}
        strokeDasharray={dash}
        fill="none"
        strokeLinecap="round"
        markerEnd={`url(#${markerId})`}
        className={reducedMotion ? undefined : "transition-[stroke-width] duration-150"}
      />
      {/* legCode label on a small chip centered on the edge. */}
      <g transform={`translate(${mid.x}, ${mid.y})`}>
        <rect
          x={-(leg.legCode.length * 4 + 8)}
          y={-11}
          width={leg.legCode.length * 8 + 16}
          height={22}
          rx={5}
          fill="hsl(var(--card))"
          stroke={stroke}
          strokeWidth={1}
        />
        <text
          x={0}
          y={1}
          textAnchor="middle"
          dominantBaseline="middle"
          className="font-mono"
          fontSize={11}
          fill={stroke}
        >
          {leg.legCode}
        </text>
      </g>
    </g>
  );
}

// ── node ─────────────────────────────────────────────────────────────────────

function Node({
  point,
  x,
  y,
  highlight,
  messages,
  orphan,
  active,
  reducedMotion,
  onSelect,
  onEditPoint,
  onHover,
  onLeave,
}: {
  point: ReturnType<typeof toRouteGraph>["points"][number];
  x: number;
  y: number;
  highlight: Highlight;
  messages: string[];
  orphan: boolean;
  active: boolean;
  reducedMotion: boolean;
  onSelect?: (scope: FindingScope) => void;
  onEditPoint?: (pointId: string) => void;
  onHover?: () => void;
  onLeave?: () => void;
}) {
  const meta = POINT_GLYPH[point.type] ?? { glyph: "•", label: point.type };
  const code =
    point.unLocode ?? point.iataCode ?? point.icaoCode ?? point.terminal ?? "";
  const name = point.name ?? point.city ?? "—";
  const locality = [point.city, point.country].filter(Boolean).join(", ");

  // Stroke precedence: blocking > active > warning > orphan > normal.
  let stroke = "hsl(var(--border))";
  let strokeWidth = 1;
  if (orphan) {
    stroke = "hsl(var(--warning))";
    strokeWidth = 1.5;
  }
  if (highlight.finding === "warning") {
    stroke = "hsl(var(--warning))";
    strokeWidth = 2;
  }
  if (active) {
    stroke = "hsl(var(--accent))";
    strokeWidth = 2.25;
  }
  if (highlight.finding === "blocking") {
    stroke = "hsl(var(--destructive))";
    strokeWidth = 2.25;
  }

  const activate = () =>
    onEditPoint ? onEditPoint(point.id) : onSelect?.({ type: "point", id: point.id });
  const interactive = !!onEditPoint || !!onSelect;

  return (
    <g
      data-point-id={point.id}
      data-type={point.type}
      data-active={active ? "true" : undefined}
      data-finding={highlight.finding ?? undefined}
      data-orphan={orphan ? "" : undefined}
      transform={`translate(${x}, ${y})`}
      className={cn(interactive && "route-focusable cursor-pointer")}
      opacity={orphan && !highlight.finding && !active ? 0.6 : 1}
      onClick={interactive ? activate : undefined}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                activate();
              }
            }
          : undefined
      }
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      onFocus={onHover}
      onBlur={onLeave}
      aria-label={`${meta.label}${code ? ` ${code}` : ""} ${name}${orphan ? " (not used by any leg)" : ""}`}
    >
      {messages.length > 0 && <title>{messages.join("\n")}</title>}
      {/* Active/selected gets a marigold halo behind the chip. */}
      {active && (
        <rect
          x={-3}
          y={-3}
          width={NODE_W + 6}
          height={NODE_H + 6}
          rx={9}
          fill="hsl(var(--accent))"
          fillOpacity={0.1}
        />
      )}
      <rect
        x={0}
        y={0}
        width={NODE_W}
        height={NODE_H}
        rx={7}
        fill="hsl(var(--card))"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeDasharray={orphan && !highlight.finding ? "4 3" : undefined}
        className={reducedMotion ? undefined : "transition-[stroke] duration-150"}
      />
      {/* Type glyph + label row. */}
      <text x={12} y={19} fontSize={13} fill="hsl(var(--muted-foreground))">
        {meta.glyph}
      </text>
      <text
        x={30}
        y={19}
        fontSize={9}
        letterSpacing={0.6}
        fill="hsl(var(--muted-foreground))"
        style={{ textTransform: "uppercase" }}
      >
        {meta.label}
      </text>
      {/* Port code — the mono co-signature — is the headline. */}
      {code ? (
        <text
          x={12}
          y={39}
          className="font-mono"
          fontSize={15}
          fontWeight={600}
          fill="hsl(var(--foreground))"
        >
          {code}
        </text>
      ) : (
        <text
          x={12}
          y={39}
          fontSize={13}
          fontWeight={600}
          fill="hsl(var(--foreground))"
        >
          {truncate(name, 20)}
        </text>
      )}
      {/* Secondary line: name (if code shown) or locality. */}
      <text x={12} y={55} fontSize={10} fill="hsl(var(--muted-foreground))">
        {code ? truncate(name, 24) : truncate(locality || "—", 24)}
      </text>
    </g>
  );
}

// ── tooltip ───────────────────────────────────────────────────────────────────

function RouteTooltip({
  detail,
  hovered,
  pos,
  pointMsgs,
  legMsgs,
}: {
  detail: QueryDetail;
  hovered: { kind: "point" | "leg"; id: string };
  pos: Map<string, Pt>;
  pointMsgs: Map<string, string[]>;
  legMsgs: Map<string, string[]>;
}) {
  const GLYPH_LABELS: Record<string, string> = {
    [PointType.PICKUP]: "Pickup",
    [PointType.DELIVERY]: "Delivery",
    [PointType.WAREHOUSE]: "Warehouse",
    [PointType.AIRPORT]: "Airport",
    [PointType.SEAPORT]: "Seaport",
  };

  if (hovered.kind === "point") {
    const point = detail.points.find((p) => p.id === hovered.id);
    if (!point) return null;

    const at = pos.get(hovered.id);
    const left = Math.max(0, (at?.x ?? 0) + NODE_W + 8);
    const top = Math.max(0, at?.y ?? 0);

    const cityPostal = [point.city, point.postalCode].filter(Boolean).join(" ");
    const code = point.unLocode ?? point.iataCode ?? point.icaoCode ?? point.terminal;
    const typeLabel = GLYPH_LABELS[point.type] ?? point.type;
    const msgs = pointMsgs.get(hovered.id) ?? [];

    return (
      <div
        role="tooltip"
        className="pointer-events-none z-10 rounded-md border bg-popover px-3 py-2 text-xs shadow-md max-w-[240px] space-y-1"
        style={{ position: "absolute", left, top }}
      >
        <div className="font-semibold">{typeLabel}{code ? ` · ${code}` : ""}</div>
        {point.name && <div>{point.name}</div>}
        {point.streetAddress && <div>{point.streetAddress}</div>}
        {cityPostal && <div>{cityPostal}</div>}
        {point.country && <div>{point.country}</div>}
        {point.contactName && <div>{point.contactName}</div>}
        {point.contactPhone && <div>{point.contactPhone}</div>}
        {point.contactEmail && <div>{point.contactEmail}</div>}
        {msgs.map((m, i) => (
          <div key={i} className="text-destructive">{m}</div>
        ))}
      </div>
    );
  }

  // kind === "leg"
  const leg = detail.legs.find((l) => l.id === hovered.id);
  if (!leg) return null;

  const oPos = leg.originPointId ? pos.get(leg.originPointId) : undefined;
  const dPos = leg.destinationPointId ? pos.get(leg.destinationPointId) : undefined;
  const midX = oPos && dPos ? (oPos.x + NODE_W + dPos.x) / 2 : (oPos?.x ?? 0) + NODE_W;
  const midY = oPos && dPos ? (oPos.y + NODE_H / 2 + dPos.y + NODE_H / 2) / 2 : (oPos?.y ?? 0) + NODE_H / 2;
  const left = Math.max(0, midX + 8);
  const top = Math.max(0, midY - 20);

  const originName = leg.originPointId
    ? (detail.points.find((p) => p.id === leg.originPointId)?.name ?? leg.originPointId)
    : "—";
  const destName = leg.destinationPointId
    ? (detail.points.find((p) => p.id === leg.destinationPointId)?.name ?? leg.destinationPointId)
    : "—";

  const rollup = leg.rollup;
  const rollupLine = `${rollup.totalPackages} pkg · ${Number(rollup.totalCbm).toFixed(4)} CBM · ${Number(rollup.totalGrossWt).toFixed(2)} kg`;
  const msgs = legMsgs.get(hovered.id) ?? [];

  return (
    <div
      role="tooltip"
      className="pointer-events-none z-10 rounded-md border bg-popover px-3 py-2 text-xs shadow-md max-w-[240px] space-y-1"
      style={{ position: "absolute", left, top }}
    >
      <div className="font-semibold">{leg.legCode} · {leg.mode ?? "no mode"}</div>
      <div>{leg.status}</div>
      <div>{originName} → {destName}</div>
      <div>{leg.assignedCargoIds.length} cargo</div>
      <div>{rollupLine}</div>
      {msgs.map((m, i) => (
        <div key={i} className="text-destructive">{m}</div>
      ))}
    </div>
  );
}

// ── legend ───────────────────────────────────────────────────────────────────

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {MODES.map((m) => (
        <span key={m} className="inline-flex items-center gap-1">
          <svg width={18} height={8} aria-hidden>
            <line
              x1={0}
              y1={4}
              x2={18}
              y2={4}
              stroke={modeColor(m)}
              strokeWidth={2.25}
              strokeDasharray={modeDash(m)}
              strokeLinecap="round"
            />
          </svg>
          <span className="font-mono">{m}</span>
        </span>
      ))}
      <span className="inline-flex items-center gap-1">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: "hsl(var(--accent))" }}
          aria-hidden
        />
        active
      </span>
      <span className="inline-flex items-center gap-1">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: "hsl(var(--destructive))" }}
          aria-hidden
        />
        issue
      </span>
    </div>
  );
}

// ── arrowhead marker ─────────────────────────────────────────────────────────

function Arrow({ id, color }: { id: string; color: string }) {
  return (
    <marker
      id={id}
      viewBox="0 0 10 10"
      refX={9}
      refY={5}
      markerWidth={7}
      markerHeight={7}
      orient="auto-start-reverse"
    >
      <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
    </marker>
  );
}

// ── layout: longest-path layering ────────────────────────────────────────────

interface Layout {
  width: number;
  height: number;
  pos: Map<string, Pt>;
}

/**
 * computeLayout — a simple longest-path layering (Stage-3 graphs are small).
 * Depth 0 = points that are never a destination (sources). Each leg pushes its
 * destination to `max(existing, depth[origin] + 1)`. Points sharing a depth are
 * stacked vertically. Isolated points (no leg) go in a trailing column so
 * orphans are still drawn.
 */
function computeLayout(graph: ReturnType<typeof toRouteGraph>): Layout {
  const pointIds = graph.points.map((p) => p.id);
  const depth = new Map<string, number>(pointIds.map((id) => [id, 0]));

  const isDestination = new Set(
    graph.legs.map((l) => l.destinationPointId).filter(Boolean) as string[],
  );
  const touched = new Set<string>();
  for (const l of graph.legs) {
    if (l.originPointId) touched.add(l.originPointId);
    if (l.destinationPointId) touched.add(l.destinationPointId);
  }

  // Sources (never a destination) start at 0; everything else derives.
  // Relax depths to a fixpoint. Cap iterations to guard against a cycle
  // (validateRoute flags cycles; we just avoid an infinite loop here).
  const maxIter = graph.legs.length + 2;
  for (let i = 0; i < maxIter; i++) {
    let changed = false;
    for (const l of graph.legs) {
      if (!l.originPointId || !l.destinationPointId) continue;
      const od = depth.get(l.originPointId) ?? 0;
      const cur = depth.get(l.destinationPointId) ?? 0;
      const next = od + 1;
      if (next > cur) {
        depth.set(l.destinationPointId, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // A point that IS a destination but also (erroneously) kept depth 0 through a
  // cycle still renders; nothing else to do.
  void isDestination;

  // Orphans (no leg touches them) trail to the right after the deepest column.
  let maxDepth = 0;
  for (const d of depth.values()) maxDepth = Math.max(maxDepth, d);
  const orphanDepth = graph.legs.length > 0 ? maxDepth + 1 : 0;
  for (const id of pointIds) {
    if (!touched.has(id)) depth.set(id, orphanDepth);
  }

  // Group by depth (stable order = point order within each column).
  const columns = new Map<number, string[]>();
  for (const id of pointIds) {
    const d = depth.get(id) ?? 0;
    const arr = columns.get(d);
    if (arr) arr.push(id);
    else columns.set(d, [id]);
  }

  const pos = new Map<string, Pt>();
  let maxRows = 0;
  const sortedDepths = [...columns.keys()].sort((a, b) => a - b);
  for (const d of sortedDepths) {
    const ids = columns.get(d)!;
    maxRows = Math.max(maxRows, ids.length);
    ids.forEach((id, row) => {
      pos.set(id, {
        x: PAD + d * (NODE_W + COL_GAP),
        y: PAD + row * (NODE_H + ROW_GAP),
      });
    });
  }

  const cols = sortedDepths.length || 1;
  const width = PAD * 2 + cols * NODE_W + (cols - 1) * COL_GAP;
  const height = PAD * 2 + maxRows * NODE_H + Math.max(0, maxRows - 1) * ROW_GAP;

  return { width: Math.max(width, 320), height: Math.max(height, NODE_H + PAD * 2), pos };
}

// ── findings → highlights ────────────────────────────────────────────────────

interface Highlights {
  points: Map<string, Highlight>;
  legs: Map<string, Highlight>;
  orphans: Set<string>;
  /** Finding messages per point/leg — rendered as the box's hover <title>. */
  pointMsgs: Map<string, string[]>;
  legMsgs: Map<string, string[]>;
}

/** Blocking outranks warning when several findings hit the same target. */
function worse(
  a: "blocking" | "warning" | null,
  b: "blocking" | "warning" | null,
): "blocking" | "warning" | null {
  if (a === "blocking" || b === "blocking") return "blocking";
  if (a === "warning" || b === "warning") return "warning";
  return null;
}

function resolveHighlights(
  graph: ReturnType<typeof toRouteGraph>,
  findings: Finding[],
): Highlights {
  const points = new Map<string, Highlight>();
  const legs = new Map<string, Highlight>();
  const pointMsgs = new Map<string, string[]>();
  const legMsgs = new Map<string, string[]>();

  const pushMsg = (map: Map<string, string[]>, id: string, msg: string) => {
    const arr = map.get(id);
    if (arr) arr.push(msg);
    else map.set(id, [msg]);
  };
  const bumpPoint = (id: string, f: Finding) => {
    points.set(id, { finding: worse(points.get(id)?.finding ?? null, f.severity) });
    pushMsg(pointMsgs, id, f.message);
  };
  const bumpLeg = (id: string, f: Finding) => {
    legs.set(id, { finding: worse(legs.get(id)?.finding ?? null, f.severity) });
    pushMsg(legMsgs, id, f.message);
  };

  // Cargo → the legs that carry it (via legCargo).
  const legsByCargo = new Map<string, string[]>();
  for (const lc of graph.legCargo) {
    const arr = legsByCargo.get(lc.cargoItemId);
    if (arr) arr.push(lc.legId);
    else legsByCargo.set(lc.cargoItemId, [lc.legId]);
  }

  for (const f of findings) {
    const { type, id } = f.scope;
    if (!id) continue;
    if (type === "point") bumpPoint(id, f);
    else if (type === "leg") bumpLeg(id, f);
    else if (type === "cargo") {
      for (const legId of legsByCargo.get(id) ?? []) bumpLeg(legId, f);
    }
    // "query" / "field" scopes surface only in the top notices strip.
  }

  // Orphans — points touched by no leg.
  const touched = new Set<string>();
  for (const l of graph.legs) {
    if (l.originPointId) touched.add(l.originPointId);
    if (l.destinationPointId) touched.add(l.destinationPointId);
  }
  const orphans = new Set<string>();
  // Only mark orphans once at least one leg exists — a fresh graph with points
  // but no legs isn't "broken", it's just unstarted.
  if (graph.legs.length > 0) {
    for (const p of graph.points) if (!touched.has(p.id)) orphans.add(p.id);
  }

  return { points, legs, orphans, pointMsgs, legMsgs };
}

// ── util ─────────────────────────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
