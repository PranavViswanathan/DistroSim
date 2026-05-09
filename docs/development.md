# Development

How to run, build, and contribute to DistroSim locally.

## Prerequisites

- Node.js 20+
- npm 10+
- (Optional) Docker for containerized builds
- (Optional) `make` for the convenience targets

## First-time setup

```bash
git clone <this repo>
cd DistroSim
npm install
```

## Run the dev server

```bash
npm run dev                  # http://localhost:5173
```

Vite serves `index.html`, hot-reloads on changes to `src/`, and rebuilds the bundle in memory. The dev server has no Express middleware — `/healthz` exists in production only.

Or with Make:

```bash
make dev                     # foreground
make dev-bg                  # background; pid in .pids/dev.pid
make dev-logs                # tail the background log
make dev-stop                # stop background
```

## Typecheck

```bash
make typecheck               # tsc --noEmit, no bundle
```

Strict mode is on (`tsconfig.json`). No `any`. No implicit `any`. Use `unknown` if a type is genuinely unknown.

## Build

```bash
npm run build
```

Produces `dist/` (client) and `server.cjs` (server). See [deployment.md](deployment.md) for what to do with them.

## Project layout

See [architecture.md](architecture.md) for the module dependency graph and a tour of every file.

The short version:

```
src/types.ts          # shared types and constants — depends on nothing
src/nodes.ts          # node helpers + id generator
src/edges.ts          # edge geometry (bezier) + hit-testing
src/presets.ts        # built-in topologies
src/simulation.ts     # per-tick traffic + latency + error model
src/chaos.ts          # kill, partition, latency, cascade primitives
src/metrics.ts        # sparkline rendering + formatters
src/canvas.ts         # canvas drawing
src/main.ts           # top-level controller + DOM/input wiring
```

`main.ts` is the controller; everything else is a focused module imported from there.

## Coding conventions

- TypeScript strict mode. No `any`, no unjustified `as`.
- Prefer `type` over `interface` for data shapes; use `interface` for behavior contracts only.
- Functional style where it pays off — `map`/`filter`/`reduce` over loops, but a `for` loop is fine when you need early exit or mutation in a hot path (the per-tick simulation uses both).
- No comments that explain *what* the code does — naming should carry that. A short comment for a non-obvious *why* is welcome.
- One mutable state object (`SimState`) — all reads and writes go through it.

## Adding features

| Want to add…              | Start in…                                                  |
|---------------------------|------------------------------------------------------------|
| New node type             | [`src/types.ts`](../src/types.ts) → [`src/simulation.ts`](../src/simulation.ts) |
| New chaos primitive       | [`src/chaos.ts`](../src/chaos.ts) — see [chaos.md](chaos.md) |
| New preset                | [`src/presets.ts`](../src/presets.ts) — see [presets.md](presets.md) |
| New global metric         | [`src/types.ts`](../src/types.ts) (`GlobalMetrics`) → [`src/metrics.ts`](../src/metrics.ts) |
| Canvas rendering tweak    | [`src/canvas.ts`](../src/canvas.ts)                        |
| Keyboard / mouse handler  | [`src/main.ts`](../src/main.ts) — see [controls.md](controls.md) |

## Common tasks

### Reset the canvas state during dev

The "Clear canvas" toolbar button removes everything; "Reset metrics" zeros counters but keeps topology. Both are non-destructive to your dev session.

### Reproduce a broken state

Use the Export button to download a topology JSON, then Import it in another tab or commit it as a fixture. JSON shape is documented in [chaos.md](chaos.md#import--export).

### Tune simulation feel

The constants at the top of [`src/simulation.ts`](../src/simulation.ts) and the per-type `case` blocks in `runTick` are the dials:

- `HISTORY_SECONDS = 60` — sparkline window
- `LATENCY_BUFFER = 600` — p99 sample buffer size
- `MAX_PACKETS = 280` — animation packet cap
- `state.ticksPerSec = 4` — tick rate

For per-node tuning, see the `serviceLatency()` helper and the per-type defaults in [`src/types.ts`](../src/types.ts).

## Cleanup

```bash
make clean                   # rm dist/ server.cjs .pids/
make distclean               # also rm node_modules/
```
