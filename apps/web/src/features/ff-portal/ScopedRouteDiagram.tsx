import { useMemo } from "react";
import { FreightMode, PointType, type FfPortalLegDto } from "@svyft/shared";
import { cn } from "@/lib/utils";
import { computeRouteLayout } from "@/lib/routeLayering";

/**
 * ScopedRouteDiagram — FF-portal "Route overview" (design §4.8.3).
 *
 * An assignment-scoped, address-masked node-graph of the legs a single
 * freight forwarder was invited to quote. Built directly from the frozen
 * `FfPortalLegDto[]` the portal already has — this is a deliberately
 * separate, self-contained component, NOT a port of the executive
 * `RouteDiagram` (query-wizard/steps/legs/RouteDiagram.tsx): that component
 * needs a full `QueryDetail` and its hover tooltip surfaces street address +
 * contact details, which the FF must never see. `RouteDiagram` is NEVER
 * imported here — only its layout constants/formulas and its node's
 * code+name treatment are mirrored, by hand, onto this masked subgraph, so
 * the two views read identically without risking a masked-field leak.
 *
 * Masking: nodes render only `type` / `code` / `name` / `country` (+ `city`
 * from the frozen manifest snapshot). `code` is the same public,
 * non-sensitive location code (IATA/UN-LOCODE/ICAO/terminal) the executive
 * shows — live-resolved onto `FfPortalEndpoint.code`, same precedence as
 * `RouteDiagram`'s node. The portal DTO doesn't carry a street address or
 * contact fields at all — there is nothing else to accidentally render, and
 * this component only ever reads that whitelist off the DTO (never
 * spreads/forwards arbitrary fields).
 *
 * Layout: nodes are positioned on the SAME grid the executive `RouteDiagram`
 * uses — the shared `computeRouteLayout` engine (`@/lib/routeLayering`),
 * called here with `splitComponents: true` so a non-contiguous scoped
 * assignment (this FF's legs don't all chain into one connected route)
 * renders as side-by-side components separated by an empty `breakCols`
 * spacer, drawn as ONE diagram with a visible break marker rather than
 * stacked separate blocks (design decision D2). Pixel constants
 * (`NODE_W`/`NODE_H`/`COL_GAP`/`ROW_GAP`/`PAD`) are copied from the
 * executive so the two views position identically. This MUST NOT revert to
 * a single-row "order of first appearance across `legs`" layout: that
 * ordering tracks assignment order, not route order, and both silently
 * desyncs from the executive's route view whenever legs were assigned out
 * of topological order, and collapses a branch/merge into one row instead
 * of stacking it (finding #1). The small `modeColor` / `modeDash` /
 * `POINT_GLYPH` / `Arrow` / `Legend` helpers below are copied from
 * `RouteDiagram` (they're pure/presentational) rather than imported, per
 * design.
 *
 * Read-only: nodes are static `<g>`s — no click/keyboard toggle, no detail
 * panel. Each node carries a hover `<title>` with the same masked whitelist
 * (`type · code · name · city, country`) for parity with the edge `<title>`.
 */

// ── layout constants (SVG user units) — match the executive RouteDiagram ────
const NODE_W = 168;
const NODE_H = 64;
const COL_GAP = 96;
const ROW_GAP = 28;
const PAD = 24;
const LEGEND_H = 26;

interface ScopedRouteDiagramProps {
  legs: FfPortalLegDto[];
  className?: string;
}

/** Short human glyph + label per point type (copied from RouteDiagram — pure/presentational). */
const POINT_GLYPH: Record<string, { glyph: string; label: string }> = {
  [PointType.PICKUP]: { glyph: "▲", label: "Pickup" },
  [PointType.DELIVERY]: { glyph: "◆", label: "Delivery" },
  [PointType.WAREHOUSE]: { glyph: "▣", label: "Warehouse" },
  [PointType.AIRPORT]: { glyph: "✈", label: "Airport" },
  [PointType.SEAPORT]: { glyph: "⚓", label: "Seaport" },
};

/** CSS custom-property color per freight mode (copied from RouteDiagram — pure/presentational). */
function modeColor(mode: FreightMode | null): string {
  if (mode === FreightMode.SEA) return "hsl(var(--mode-sea))";
  if (mode === FreightMode.AIR) return "hsl(var(--mode-air))";
  if (mode === FreightMode.ROAD) return "hsl(var(--mode-road))";
  return "hsl(var(--muted-foreground))"; // no mode on the frozen manifest
}

/** Dash pattern encodes the mode as a redundant, colorblind-safe channel (copied from RouteDiagram). */
function modeDash(mode: FreightMode | null): string | undefined {
  if (mode === FreightMode.SEA) return "10 6"; // wake
  if (mode === FreightMode.AIR) return "2 6"; // flight path (dotted)
  return undefined; // ROAD / unset = solid
}

const MODES: FreightMode[] = [FreightMode.ROAD, FreightMode.SEA, FreightMode.AIR];

// ── masked node/edge model, built straight from the portal DTO ──────────────

export interface ScopedNode {
  pointId: string;
  type: string;
  name: string | null;
  country: string | null;
  code: string | null;
  city: string | null;
}

export interface ScopedEdge {
  legId: string;
  legCode: string;
  mode: FreightMode | null;
  fromPointId: string;
  toPointId: string;
}

export interface ScopedGraph {
  nodes: ScopedNode[];
  edges: ScopedEdge[];
}

/**
 * Builds a deduped node list (identity = `pointId`) + one edge per leg that
 * has both endpoints. `endpoints[0]` is the leg's origin, `endpoints[1]` its
 * destination — that's the order the api builds `FfPortalLegDto.endpoints`
 * in (origin, then destination). A leg with fewer than 2 endpoints
 * contributes what it can (a lone node, or nothing) rather than throwing.
 *
 * Exported for `ScopedRouteDiagram.test.tsx`. Round 4 #2 originally also
 * exported this so `legOrder.ts`'s `orderLegsByRoute` could build the SAME
 * graph this diagram lays out from; S5.9.3 Task 2 replaced that with a call
 * straight to `@svyft/shared`'s generic `orderLegsByRoute` (accessors on
 * `endpoints[0]/[1].pointId`, no separate node/edge graph object) — see that
 * function's own doc comment for why the two stay equivalent without sharing
 * this exact object.
 */
export function buildScopedGraph(legs: FfPortalLegDto[]): ScopedGraph {
  const nodes = new Map<string, ScopedNode>();
  const edges: ScopedEdge[] = [];

  for (const leg of legs) {
    const origin = leg.endpoints[0];
    const destination = leg.endpoints[1];
    const originCity = leg.manifest.origin?.city ?? null;
    const destCity = leg.manifest.destination?.city ?? null;

    if (origin && !nodes.has(origin.pointId)) {
      nodes.set(origin.pointId, {
        pointId: origin.pointId,
        type: origin.type,
        name: origin.name,
        country: origin.country,
        code: origin.code,
        city: originCity,
      });
    }
    if (destination && !nodes.has(destination.pointId)) {
      nodes.set(destination.pointId, {
        pointId: destination.pointId,
        type: destination.type,
        name: destination.name,
        country: destination.country,
        code: destination.code,
        city: destCity,
      });
    }
    if (origin && destination) {
      edges.push({
        legId: leg.legId,
        legCode: leg.manifest.legCode,
        mode: leg.manifest.mode,
        fromPointId: origin.pointId,
        toPointId: destination.pointId,
      });
    }
  }

  return { nodes: [...nodes.values()], edges };
}

interface Pt {
  x: number;
  y: number;
}

interface Layout {
  width: number;
  height: number;
  pos: Map<string, Pt>;
  /** Spacer column indices between disconnected components — see `computeRouteLayout`. */
  breakCols: number[];
}

/**
 * computeLayout — SVG pixel math on top of the shared `computeRouteLayout`
 * grid engine, called with `splitComponents: true` (unlike the executive's
 * `splitComponents: false`) so a non-contiguous scoped assignment lays out
 * as side-by-side components with break-gap spacer columns between them
 * instead of silently merging unrelated points into one grid. The pixel
 * conversion itself — `x = PAD + col*(NODE_W+COL_GAP)`, `y = PAD +
 * row*(NODE_H+ROW_GAP)`, and the width/height formulas — is copied from
 * `RouteDiagram.computeLayout` verbatim (with NODE_W/H, COL_GAP/ROW_GAP, PAD
 * matching the executive's constants) so the two diagrams position
 * identically. Only this file's own presentational chrome (edges, node
 * card, legend strip) differs — the grid math does not.
 */
function computeLayout(graph: ScopedGraph): Layout {
  const pointIds = graph.nodes.map((n) => n.pointId);
  const edges = graph.edges.map((e) => ({
    originId: e.fromPointId,
    destinationId: e.toPointId,
  }));

  const engineLayout = computeRouteLayout(pointIds, edges, { splitComponents: true });

  const pos = new Map<string, Pt>();
  for (const [id, node] of engineLayout.nodes) {
    pos.set(id, {
      x: PAD + node.col * (NODE_W + COL_GAP),
      y: PAD + node.row * (NODE_H + ROW_GAP),
    });
  }

  // Unlike this renderer, the engine doesn't floor colCount to 1 for an
  // empty graph (0 nodes/edges) — keep that floor here so `width` never
  // collapses below a single empty column's baseline. `computeLayout` is
  // only ever called once the caller has confirmed at least one node exists
  // (see the empty-state guard in `ScopedRouteDiagram` below), so this is
  // belt-and-suspenders, mirroring `RouteDiagram.computeLayout`'s identical
  // guard.
  const cols = engineLayout.colCount || 1;
  const maxRows = engineLayout.maxRows;
  const width = PAD * 2 + cols * NODE_W + (cols - 1) * COL_GAP;
  const height = PAD * 2 + maxRows * NODE_H + Math.max(0, maxRows - 1) * ROW_GAP;

  return {
    width: Math.max(width, NODE_W + PAD * 2),
    height: Math.max(height, NODE_H + PAD * 2),
    pos,
    breakCols: engineLayout.breakCols,
  };
}

export function ScopedRouteDiagram({ legs, className }: ScopedRouteDiagramProps) {
  const graph = useMemo(() => buildScopedGraph(legs), [legs]);
  const layout = useMemo(() => computeLayout(graph), [graph]);

  if (graph.nodes.length === 0) {
    return (
      <div
        data-slot="scoped-route-diagram"
        className={cn(
          "rounded-md border border-dashed bg-card p-6 text-center text-sm text-muted-foreground",
          className,
        )}
      >
        No route to display
      </div>
    );
  }

  const { width, height, pos, breakCols } = layout;
  const svgHeight = height + LEGEND_H;

  return (
    <figure
      data-slot="scoped-route-diagram"
      className={cn("overflow-x-auto rounded-md border bg-card p-3", className)}
      aria-label="Route overview"
    >
      <figcaption className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Route overview
        </span>
        <Legend />
      </figcaption>

      <svg
        role="img"
        aria-label="Route overview — leg endpoints wired left to right"
        width={width}
        height={svgHeight}
        viewBox={`0 0 ${width} ${svgHeight}`}
        className="max-w-full"
        style={{ minWidth: Math.min(width, 280) }}
      >
        <defs>
          {MODES.map((m) => (
            <Arrow key={m} id={`sr-arrow-${m}`} color={modeColor(m)} />
          ))}
          <Arrow id="sr-arrow-unset" color="hsl(var(--muted-foreground))" />
        </defs>

        {/* Break markers first, so they read as quiet background structure
            behind the edges/nodes rather than a foreground element. */}
        <g>
          {breakCols.map((col) => (
            <BreakMarker
              key={col}
              x={PAD + col * (NODE_W + COL_GAP) + NODE_W / 2}
              top={PAD / 2}
              bottom={height - PAD / 2}
            />
          ))}
        </g>

        {/* Edges next, so nodes paint on top. */}
        <g>
          {graph.edges.map((edge) => {
            const from = pos.get(edge.fromPointId);
            const to = pos.get(edge.toPointId);
            if (!from || !to) return null; // guard, shouldn't happen
            return <Edge key={edge.legId} edge={edge} from={from} to={to} />;
          })}
        </g>

        {/* Nodes. */}
        <g>
          {graph.nodes.map((node) => {
            const at = pos.get(node.pointId);
            if (!at) return null; // guard, shouldn't happen
            return <Node key={node.pointId} node={node} x={at.x} y={at.y} />;
          })}
        </g>
      </svg>
    </figure>
  );
}

// ── edge ─────────────────────────────────────────────────────────────────────

function Edge({ edge, from, to }: { edge: ScopedEdge; from: Pt; to: Pt }) {
  // Anchor at the right edge of the origin node and left edge of the
  // destination node — same anchoring as the executive's Edge, generalized
  // to per-node y (nodes can now sit on different rows).
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;

  // A gentle cubic, same idea as RouteDiagram's edge — guards a negative
  // delta (e.g. a leg that loops back to an earlier column) with a floor.
  const dx = Math.max(40, (x2 - x1) / 2);
  const path = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  const stroke = modeColor(edge.mode);
  const dash = modeDash(edge.mode);
  const markerId = edge.mode ? `sr-arrow-${edge.mode}` : "sr-arrow-unset";
  const mid = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };

  return (
    <g data-leg-id={edge.legId} data-mode={edge.mode ?? "NONE"}>
      <title>{`Leg ${edge.legCode}${edge.mode ? ` (${edge.mode})` : ""}`}</title>
      <path
        d={path}
        stroke={stroke}
        strokeWidth={2.25}
        strokeDasharray={dash}
        fill="none"
        strokeLinecap="round"
        markerEnd={`url(#${markerId})`}
      />
      {/* legCode label on a small chip centered on the edge. */}
      <g transform={`translate(${mid.x}, ${mid.y})`}>
        <rect
          x={-(edge.legCode.length * 4 + 8)}
          y={-11}
          width={edge.legCode.length * 8 + 16}
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
          {edge.legCode}
        </text>
      </g>
    </g>
  );
}

// ── break marker ─────────────────────────────────────────────────────────────

/**
 * A subtle vertical break between two disconnected components — a dashed
 * rule spanning the diagram height plus a small glyph badge at its
 * midpoint — so a non-contiguous FF assignment (legs that don't all chain
 * into one route) still reads as ONE diagram with a visible gap, not
 * separate stacked blocks (design decision D2). Purely decorative —
 * `aria-hidden`, no text alternative needed beyond the diagram itself.
 */
function BreakMarker({ x, top, bottom }: { x: number; top: number; bottom: number }) {
  const midY = (top + bottom) / 2;
  return (
    <g data-testid="route-break" aria-hidden="true">
      <line
        x1={x}
        y1={top}
        x2={x}
        y2={bottom}
        stroke="hsl(var(--border))"
        strokeWidth={1.5}
        strokeDasharray="4 4"
      />
      <g transform={`translate(${x}, ${midY})`}>
        <circle r={9} fill="hsl(var(--card))" stroke="hsl(var(--border))" strokeWidth={1} />
        <text
          x={0}
          y={1}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={10}
          fill="hsl(var(--muted-foreground))"
        >
          ⋯
        </text>
      </g>
    </g>
  );
}

// ── node ─────────────────────────────────────────────────────────────────────

function Node({ node, x, y }: { node: ScopedNode; x: number; y: number }) {
  const meta = POINT_GLYPH[node.type] ?? { glyph: "•", label: node.type };
  const name = node.name ?? "—";
  const code = node.code ?? "";
  const locality = [node.city, node.country].filter(Boolean).join(", ");

  // Masked hover detail, parity with the edge's <title> — same whitelist
  // rendered on the card (type/code/name/locality), just all on one line.
  const titleParts = [meta.label];
  if (code) titleParts.push(code);
  titleParts.push(name);
  if (locality) titleParts.push(locality);

  return (
    <g
      data-point-id={node.pointId}
      data-type={node.type}
      transform={`translate(${x}, ${y})`}
      aria-label={`${meta.label}${code ? ` ${code}` : ""} ${name}`}
    >
      <title>{titleParts.join(" · ")}</title>
      <rect
        x={0}
        y={0}
        width={NODE_W}
        height={NODE_H}
        rx={7}
        fill="hsl(var(--card))"
        stroke="hsl(var(--border))"
        strokeWidth={1}
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
      {/* Code — the mono co-signature — is the headline (mirrors the
          executive's Node); falls back to the name when there's no code. */}
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
        <text x={12} y={39} fontSize={13} fontWeight={600} fill="hsl(var(--foreground))">
          {truncate(name, 20)}
        </text>
      )}
      {/* Secondary line: name (if code shown) or locality — never a street
          address or contact detail (masking whitelist: type/code/name/city/country). */}
      <text x={12} y={55} fontSize={10} fill="hsl(var(--muted-foreground))">
        {code ? truncate(name, 24) : truncate(locality || "—", 24)}
      </text>
    </g>
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

// ── util ─────────────────────────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
