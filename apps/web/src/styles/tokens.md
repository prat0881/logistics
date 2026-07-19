# Svyft Logistics — Design tokens

> The visual system for the Stage-3 frontend. Every screen (Query List, the
> 5-step Create-Query wizard, the leg/route builder + route diagram) derives its
> color, type, and spacing from the tokens here.

## Direction: the operations console

An **operational instrument**, not a marketing page. The user is a logistics
executive at a freight-forwarding desk who turns a client's shipping request
("3 breakbulk units, Nhava Sheva → Rotterdam, ~180 CBM, ready next month") into
a structured, biddable **query** — a code, a set of **legs** (origin → destination
+ mode + cargo), a **route** assembled from those legs, then fired to carriers as
an RFQ. It is data-dense, used all day, internal.

**The leg/route is the product's spine.** A query *is* a path through ports. The
design reads as **precision + trust** — chart paper, manifests, bill-of-lading
ink — and it keeps the field deliberately quiet so the one place we spend
boldness (the route) reads as the signal in the instrument.

Grounded in the subject's vernacular: UNLOCODE port codes (INNSA, NLRTM), IMO
numbers, CBM, gross/net weight, tabular manifests, and status stamps
(DRAFT → RFQ_READY). Those artifacts drive the choices below.

---

## Palette

Named hex → shipped as HSL triplets in `index.css` (shadcn convention).
Two full themes: **light** ("ledger under fluorescent light") is the default;
**dark** ("night bridge — instrument at sea") flips the same slots.

### Light (`:root`)

| Token | Hex | Role |
|---|---|---|
| `background` | `#F4F6FA` | Cool blue-grey ledger ground — the desk |
| `foreground` | `#0E1826` | Near-navy ink (never pure black) |
| `card` | `#FFFFFF` | White **readout panel** — where data lives |
| `muted` | `#EAEEF4` | Quiet fill: table headers, chips, inactive stepper |
| `muted-foreground` | `#586576` | Secondary ink: labels, captions, meta |
| `border` | `#DCE2EB` | Hairline rule |
| `primary` | `#0A4FA0` | **Deep maritime cobalt** — primary actions, links, focus |
| `accent` | `#E08A17` | **Signal amber / ochre** — the signature. Route + true highlights only |
| `success` | `#12795A` | Manifest green — cleared / RFQ_READY |
| `warning` | `#B45309` | Amber-brown — attention / needs input |
| `destructive` | `#BE2436` | Rejected / error stamp |

### Dark (`.dark`)

| Token | Hex | Note |
|---|---|---|
| `background` | `#0B1420` | Deep navy console |
| `foreground` | `#E6ECF3` | Cool off-white |
| `card` | `#111D2E` | Raised panel |
| `muted` | `#18263A` | / `muted-foreground` `#93A2B5` |
| `border` | `#22344B` | Hairline |
| `primary` | `#3D8BE0` | Cobalt lifted for dark contrast |
| `accent` | `#F0A93B` | Amber lifts on dark |
| `success` | `#2BA57C` · `warning` `#D98324` · `destructive` `#E4586A` | |

**Contrast (WCAG):** light body 16.5:1, muted-fg 5.5:1, primary button 7.4:1,
accent-on-fill 5.4:1, cobalt links 8.0:1; dark body 15.6:1, muted-fg 7.1:1,
primary button 5.4:1. All AA (most AAA).

**Discipline — one bold place.** The whole field is cobalt-and-grey monochrome so
**amber is reserved for the route**: the active leg edge and its port nodes in the
RouteDiagram, plus a small set of genuine highlights (the current wizard step, an
"active" status pip). Amber is **never** a primary button — primary actions are
cobalt. If amber shows up anywhere that isn't "this is the live path / the thing
you're on," it's a bug.

---

## Type — three roles

Self-hosted via `@fontsource` (no runtime CDN). Imported in `main.tsx`.

| Role | Face | Utility | Where |
|---|---|---|---|
| **Display** | **Space Grotesk** (500/600) | `font-display` | Wordmark, page H1s, step numbers — **only**. Tight tracking, weight 600, read as *stenciled equipment labeling*, not hero copy |
| **Body / UI** | **Inter** (400/500/600) | `font-sans` | Everything: labels, buttons, table text, forms. The invisible workhorse |
| **Data / mono** | **IBM Plex Mono** (400/500) | `font-mono` + `tnum` | Query codes, port/UNLOCODE, IMO, CBM, weights, dims, dates, every numeric table column. Tabular numerals so columns align |

**Type scale** (Inter unless noted): page H1 `text-xl`/`text-2xl` **Space Grotesk 600**;
section H2 `text-sm` uppercase tracked **muted-foreground** (a manifest field header);
body `text-sm`; caption/meta `text-xs` muted; data cells `text-sm font-mono` with
`font-feature-settings:"tnum" 1`.

The mono face is a **co-signature**: aligned Plex Mono numerals are what make a
table read as an instrument readout rather than a generic CRUD grid.

---

## Layout — "the manifest"

Every screen is an instrument readout on the ledger ground.

```
┌──────────────────────────────────────────────────────────┐
│  SVYFT ·LOGISTICS   Queries  Clients  Vessels   user ▸ ⎋ │  header: display wordmark
├──────────────────────────────────────────────────────────┤  + hairline cobalt rule
│                                                          │
│   Queries                        [ search… ]  [+ New ]   │  toolbar: single line
│  ┌────────────────────────────────────────────────────┐ │
│  │ CODE▏     Client        Route          CBM   Status │ │  card = white readout panel
│  │ SVQ-0421  Meridian Co.  INNSA→NLRTM   180.0  ●RFQ   │ │  mono numeric cols, right-aligned
│  │ SVQ-0422  Trans-Pac     CNSHA→USLAX   412.5  ○Draft │ │  hairline row rules
│  └────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

Wizard (later tasks): left-rail **numbered stepper** (display-face numerals) +
persistent header + right **findings / RouteDiagram rail** on Step 4.

- **Radius:** `--radius: 0.5rem` base scale; interactive/surface elements use
  `rounded-md` which resolves to **6px** (shadcn `md = radius − 2px`) — soft enough
  to feel like a tool, not a broadsheet.
- **Borders:** hairline `--border`; cards sit on the grey ground with a faint edge.
- **Spacing:** disciplined and dense — 6px radius, generous vertical rhythm in
  forms, tight rows in tables.

---

## Signature — the RouteDiagram

A query *is* a route, so we render the route as a **literal node-graph**: port
nodes connected by leg edges laid out left-to-right, with **amber marking the
active leg and its nodes** against the otherwise-monochrome field.

```
   ●━━━━━━━━━●╍╍╍╍╍╍╍╍○ ─ ─ ─ ○
  INNSA    NLRTM     DEHAM    (add leg)
  ▲ cobalt  ▲ amber = active leg
```

No generic CRUD admin ships this — it makes the app's core abstraction
(query = path through ports) visible, and it is the payoff the quiet cobalt/grey
field exists to support. It arrives in a later task; the tokens here reserve
amber for it.

---

## Critique pass — what changed from the starting direction, and why

The brief proposed cobalt/marigold + Space Grotesk / Inter / IBM Plex Mono. I
treated it as a starting point and pushed each slot to be specific to *this*
brief (a logistics instrument), not a generic default. Checked against the three
current AI-default looks — (1) warm-cream + serif + terracotta, (2) near-black +
acid-green/vermilion, (3) broadsheet hairlines + zero radius — this lands on none
of them.

- **Primary cobalt `#0B5FBA` → `#0A4FA0` (deeper, inkier).** Bright cobalt is the
  default "enterprise SaaS blue." Blue is *right* for maritime freight, so I kept
  it but pulled it to a deeper, slightly-desaturated **maritime navy-cobalt** that
  reads as printed bill-of-lading ink. Not abandoned — made specific.
- **Background pure white/slate → `#F4F6FA` cool blue-grey ledger ground.** A faint
  cool cast (chart paper under fluorescent light) so white **cards read as readout
  panels**. Avoids trap #1's warm cream and trap #2's near-black.
- **Accent marigold `#F2A413` → `#E08A17` signal amber/ochre.** Raw marigold read
  candy/orange-juice. Shifted toward a browner **ochre** — chart-buoy / customs-stamp
  amber — and, per the skill's "spend boldness in one place," **restricted to the
  RouteDiagram + true highlights, never a primary button.** Keeps it from being a
  generic CTA color and reserves it as the instrument's signal (not trap #2's acid).
- **Space Grotesk display — kept but hard-constrained.** Space Grotesk is itself
  becoming an AI default, but its gridded, mechanical letterforms fit an instrument
  panel. Risk mitigated by discipline: display face **only** for wordmark, H1s, and
  step numbers, at weight 600 with tight tracking so it reads as *equipment
  labeling*, not startup-hero. If a screenshot shows it reading generic, the
  fallback is a more distinctive grotesque — but constrained Space Grotesk is
  defensible for a panel.
- **Inter body — unchanged, deliberately.** The correct invisible workhorse for
  data-dense UI. The skill says keep everything around the signature quiet; "boring"
  is the right call here.
- **IBM Plex Mono data — kept and promoted to co-signature.** The strongest part of
  the starting direction: real character (slab terminals, distinctive `a`/`g`) and
  the "engineering/manifest" mono. With `tnum` it aligns port codes and CBM columns —
  the thing that makes the field read as an instrument.
- **Radius 6px, hairline borders, dense tables — kept, but framed as a *console*,
  not a broadsheet.** I borrow the density of trap #3 (correct for a manifest) but
  reject its zero-radius newspaper feel: 6px radius on surfaces, cards with a real
  faint edge, a rails/stepper/toolbar console layout rather than columned prose.
