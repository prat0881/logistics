import { useMemo, useState } from "react";
import { FreightMode, PointType, type FfPortalLegDto } from "@svyft/shared";
import { cn } from "@/lib/utils";
import { computeLongestPathDepth } from "@/lib/routeLayering";

/**
 * ScopedRouteDiagram — FF-portal "Route overview" (design §4.8.3).
 *
 * An assignment-scoped, address-masked node-graph of the legs a single
 * freight forwarder was invited to quote. Built directly from the frozen
 * `FfPortalLegDto[]` the portal already has — this is a deliberately
 * separate, self-contained component, NOT a port of the executive
 * `RouteDiagram` (query-wizard/steps/legs/RouteDiagram.tsx): that component
 * needs a full `QueryDetail` and its hover tooltip surfaces street address +
 * contact details, which the FF must never see. It's also read-only here —
 * no `onEditPoint`/`onEditLeg`-equivalent props exist, so a node click only
 * ever toggles the local masked-detail panel below, never navigation/edit.
 *
 * Masking: nodes render only `type` / `name` / `country` (+ `city` from the
 * frozen manifest snapshot). The portal DTO (`FfPortalEndpoint`) doesn't
 * carry a street address or contact fields at all — there is nothing else
 * to accidentally render, and this component only ever reads that whitelist
 * off the DTO (never spreads/forwards arbitrary fields).
 *
 * Layout is a single left-to-right row, one column per node. Column ORDER
 * is the executive's longest-path layering (`computeLongestPathDepth` in
 * `@/lib/routeLayering`, shared with `RouteDiagram`'s `computeLayout`):
 * sources at depth 0, each leg pushes its destination to
 * `max(existing, depth[origin] + 1)`. That's a pure-topology computation —
 * it only reads point ids + each leg's origin/destination id, never the
 * masked-away fields — so it works unchanged on this scoped, masked subgraph.
 * This must NOT default back to "order of first appearance across `legs`":
 * that ordering tracks assignment order, not route order, and silently
 * desyncs from the executive's route view whenever legs were assigned out
 * of topological order (finding #1). Only the ordering is shared; the pixel
 * layout stays single-row (unlike `RouteDiagram`'s multi-row stacking) since
 * a small, single-FF scoped view doesn't need it. The small `modeColor` /
 * `modeDash` / `POINT_GLYPH` helpers below are copied from `RouteDiagram`
 * (they're pure/presentational) rather than imported, per design.
 */

// ── layout constants (SVG user units) ────────────────────────────────────────
const NODE_W = 168;
const NODE_H = 56;
const COL_GAP = 72;
const PAD = 20;
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

interface ScopedNode {
  pointId: string;
  type: string;
  name: string | null;
  country: string | null;
  city: string | null;
}

interface ScopedEdge {
  legId: string;
  legCode: string;
  mode: FreightMode | null;
  fromPointId: string;
  toPointId: string;
}

interface ScopedGraph {
  nodes: ScopedNode[];
  edges: ScopedEdge[];
}

/**
 * Builds a deduped node list (identity = `pointId`) + one edge per leg that
 * has both endpoints. `endpoints[0]` is the leg's origin, `endpoints[1]` its
 * destination — that's the order the api builds `FfPortalLegDto.endpoints`
 * in (origin, then destination). A leg with fewer than 2 endpoints
 * contributes what it can (a lone node, or nothing) rather than throwing.
 */
function buildScopedGraph(legs: FfPortalLegDto[]): ScopedGraph {
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
        city: originCity,
      });
    }
    if (destination && !nodes.has(destination.pointId)) {
      nodes.set(destination.pointId, {
        pointId: destination.pointId,
        type: destination.type,
        name: destination.name,
        country: destination.country,
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

/**
 * Orders nodes by the executive route topology — longest-path depth via the
 * shared `computeLongestPathDepth` (depth 0 = sources, each edge pushes its
 * destination to `max(existing, depth[origin] + 1)`) — so a source→sink
 * chain always renders left-to-right regardless of the order `legs` were
 * assigned in. Depth is the sort key; `Array.prototype.sort` is stable, so
 * nodes sharing a depth (e.g. a fork/branch in the assigned subgraph) keep
 * their original discovery order rather than being reshuffled arbitrarily —
 * this is still a single-row layout (see `computeLayout`), so a shared depth
 * just means adjacent columns, not a stacked/parallel row.
 */
function orderNodesByTopology(nodes: ScopedNode[], edges: ScopedEdge[]): ScopedNode[] {
  const depth = computeLongestPathDepth(
    nodes.map((n) => n.pointId),
    edges.map((e) => ({ originId: e.fromPointId, destinationId: e.toPointId })),
  );
  return [...nodes].sort((a, b) => (depth.get(a.pointId) ?? 0) - (depth.get(b.pointId) ?? 0));
}

interface Layout {
  width: number;
  height: number;
  pos: Map<string, number>; // pointId -> x; single row, y is constant
}

/**
 * Single-row, left-to-right layout — one column per node, in the order the
 * `nodes` array is given. Callers are expected to pre-order `nodes`
 * (`orderNodesByTopology`) — this function is deliberately unaware of edges
 * or topology, it just lays out whatever order it's handed.
 */
function computeLayout(nodes: ScopedNode[]): Layout {
  const pos = new Map<string, number>();
  nodes.forEach((n, i) => pos.set(n.pointId, PAD + i * (NODE_W + COL_GAP)));
  const cols = Math.max(nodes.length, 1);
  const width = PAD * 2 + cols * NODE_W + (cols - 1) * COL_GAP;
  const height = PAD * 2 + NODE_H;
  return { width: Math.max(width, NODE_W + PAD * 2), height, pos };
}

export function ScopedRouteDiagram({ legs, className }: ScopedRouteDiagramProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const graph = useMemo(() => buildScopedGraph(legs), [legs]);
  const orderedNodes = useMemo(
    () => orderNodesByTopology(graph.nodes, graph.edges),
    [graph.nodes, graph.edges],
  );
  const layout = useMemo(() => computeLayout(orderedNodes), [orderedNodes]);

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

  const { width, height, pos } = layout;
  const rowY = PAD; // single row
  const svgHeight = height + LEGEND_H;
  const selected = orderedNodes.find((n) => n.pointId === selectedId) ?? null;

  const toggle = (pointId: string) => setSelectedId((cur) => (cur === pointId ? null : pointId));

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

        {/* Edges first, so nodes paint on top. */}
        <g>
          {graph.edges.map((edge) => {
            const x1 = pos.get(edge.fromPointId);
            const x2 = pos.get(edge.toPointId);
            if (x1 === undefined || x2 === undefined) return null; // guard, shouldn't happen
            return (
              <Edge
                key={edge.legId}
                edge={edge}
                x1={x1 + NODE_W}
                y1={rowY + NODE_H / 2}
                x2={x2}
                y2={rowY + NODE_H / 2}
              />
            );
          })}
        </g>

        {/* Nodes — rendered in topological order (see `orderNodesByTopology`), so
            visual left-to-right order and DOM/tab order agree. */}
        <g>
          {orderedNodes.map((node) => {
            const x = pos.get(node.pointId) ?? 0;
            return (
              <Node
                key={node.pointId}
                node={node}
                x={x}
                y={rowY}
                selected={node.pointId === selectedId}
                onToggle={() => toggle(node.pointId)}
              />
            );
          })}
        </g>
      </svg>

      {selected && <NodeDetail node={selected} />}
    </figure>
  );
}

// ── edge ─────────────────────────────────────────────────────────────────────

function Edge({
  edge,
  x1,
  y1,
  x2,
  y2,
}: {
  edge: ScopedEdge;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}) {
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

// ── node ─────────────────────────────────────────────────────────────────────

function Node({
  node,
  x,
  y,
  selected,
  onToggle,
}: {
  node: ScopedNode;
  x: number;
  y: number;
  selected: boolean;
  onToggle: () => void;
}) {
  const meta = POINT_GLYPH[node.type] ?? { glyph: "•", label: node.type };
  const name = node.name ?? "—";
  const locality = [node.city, node.country].filter(Boolean).join(", ");

  return (
    <g
      data-point-id={node.pointId}
      data-type={node.type}
      transform={`translate(${x}, ${y})`}
      className="cursor-pointer"
      onClick={onToggle}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
      aria-label={`${meta.label} ${name}${selected ? " (selected)" : ""}`}
    >
      <rect
        x={0}
        y={0}
        width={NODE_W}
        height={NODE_H}
        rx={7}
        fill="hsl(var(--card))"
        stroke={selected ? "hsl(var(--primary))" : "hsl(var(--border))"}
        strokeWidth={selected ? 2 : 1}
      />
      {/* Type glyph + label row. */}
      <text x={12} y={17} fontSize={13} fill="hsl(var(--muted-foreground))">
        {meta.glyph}
      </text>
      <text
        x={30}
        y={17}
        fontSize={9}
        letterSpacing={0.6}
        fill="hsl(var(--muted-foreground))"
        style={{ textTransform: "uppercase" }}
      >
        {meta.label}
      </text>
      {/* Masked name — never a street address. */}
      <text x={12} y={35} fontSize={13} fontWeight={600} fill="hsl(var(--foreground))">
        {truncate(name, 22)}
      </text>
      {/* Masked locality — city/country only, never a contact. */}
      <text x={12} y={49} fontSize={10} fill="hsl(var(--muted-foreground))">
        {truncate(locality || "—", 24)}
      </text>
    </g>
  );
}

// ── node detail (click-to-reveal) ────────────────────────────────────────────

function NodeDetail({ node }: { node: ScopedNode }) {
  const meta = POINT_GLYPH[node.type] ?? { glyph: "•", label: node.type };
  const locality = [node.city, node.country].filter(Boolean).join(", ");

  return (
    <div
      role="status"
      data-testid="scoped-route-node-detail"
      className="mt-2 max-w-xs space-y-0.5 rounded-md border bg-popover px-3 py-2 text-xs"
    >
      <div className="font-semibold">
        {meta.glyph} {meta.label}
      </div>
      <div>{node.name ?? "—"}</div>
      <div>{locality || "—"}</div>
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
