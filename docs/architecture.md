# Architecture

DistroSim is a single-page browser app served by a tiny Express static server in production. There is no backend simulation, no database, and no UI framework — every node, edge, packet, and chart is rendered to a single `<canvas>` from plain TypeScript modules.

## Stack at a glance

| Layer        | Choice                                | Notes |
|--------------|---------------------------------------|-------|
| Language     | TypeScript (strict)                   | `tsconfig.json`, `tsconfig.server.json` |
| Build        | Vite 5                                | `vite.config.ts` |
| UI           | Vanilla DOM + a single `<canvas>`     | No React/Vue/Svelte |
| Server       | Express 4 (production only)           | `server.cts` → compiled to `server.cjs` |
| Container    | Multi-stage Node 20 Alpine            | `Dockerfile` |
| Deploy       | Railway via `railway.toml`, or any Docker host |

## Repository layout

```
DistroSim/
├── index.html                # Entry HTML; loads /src/main.ts
├── src/
│   ├── main.ts               # Top-level controller: DOM wiring, input, render loop
│   ├── canvas.ts             # Canvas rendering: nodes, edges, packets, ports
│   ├── simulation.ts         # The per-tick traffic + latency + error model
│   ├── chaos.ts              # Chaos primitives: kill, partition, latency, cascade
│   ├── nodes.ts              # Node creation, hit-testing, ports
│   ├── edges.ts              # Edge creation, bezier geometry, hit-testing
│   ├── presets.ts            # Built-in topology presets
│   ├── metrics.ts            # Sparkline rendering + metric formatting
│   └── types.ts              # Shared types and constants
├── server.cts                # Express static-file server (TS source)
├── server.cjs                # Compiled server output (committed only after build)
├── Dockerfile                # Multi-stage build → `node server.cjs`
├── Makefile                  # `make help` for dev/build/serve/docker targets
└── docs/                     # This folder
```

## Module dependency graph

```
                     ┌────────────┐
                     │  types.ts  │  (no imports)
                     └─────┬──────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
   ┌─────────┐        ┌──────────┐       ┌──────────┐
   │ nodes.ts│        │ edges.ts │◀──────│  ...     │
   └────┬────┘        └────┬─────┘
        │                  │
        ├─────────┬────────┘
        ▼         ▼
  ┌──────────┐ ┌────────────┐
  │presets.ts│ │simulation  │
  └────┬─────┘ │   .ts      │
       │       └─────┬──────┘
       │             │
       ▼             ▼
            ┌──────────────┐
            │   chaos.ts   │
            └──────┬───────┘
                   │
                   ▼
            ┌──────────────┐
            │  canvas.ts   │
            └──────┬───────┘
                   │
                   ▼
            ┌──────────────┐
            │   main.ts    │   ← top-level controller
            └──────────────┘
```

`types.ts` is the only module everything depends on; it has no dependencies of its own. Anything that mutates simulation state lives behind `simulation.ts` or `chaos.ts`.

## Data flow per frame

1. **`main.ts`** drives the `requestAnimationFrame` loop.
2. On each tick boundary (4 Hz by default — `state.ticksPerSec`), `simulation.runTick(state)` walks the topology and:
   - Sources traffic from `Client` nodes
   - BFS-orders nodes from clients downstream
   - Computes per-node load, errors, latency, throughput
   - Forwards traffic across non-partitioned, non-down edges
   - Spawns animation packets for live edges
   - Updates rolling p99 latency, availability, throughput, error rate
3. Between ticks, `simulation.advancePackets(state, dt)` interpolates packet positions for smooth animation.
4. **`canvas.ts`** redraws the entire scene every frame: edges, packets, nodes, port handles, selection chrome.
5. **`metrics.ts`** redraws the sparklines into their own small canvases.
6. Sidebars are plain DOM updated imperatively from `main.ts`.

## State ownership

There is exactly one piece of mutable state: the `SimState` returned by `createSimState()` (see [simulation.md](simulation.md)). All chaos primitives, all UI commands, and the render loop read from and write to that object directly. There is no event bus, no observable pattern, and no diffing — the canvas is fully cleared and redrawn each frame.

## Why no framework?

The simulation is dominated by canvas drawing and per-tick math. A virtual DOM buys nothing here, and adding React would force a state-management decision that the current single-mutable-object design avoids. The whole client compiles to a small bundle, and the renderer stays under one file.

## See also

- [Simulation model](simulation.md)
- [Node types](node-types.md)
- [Chaos primitives](chaos.md)
- [Presets](presets.md)
