# DistroSim

> A browser-based distributed-systems simulator with chaos engineering. Build topologies on a canvas, watch traffic flow tick by tick, then break things and see how the metrics react.

Vanilla TypeScript + Vite + a single `<canvas>`. No UI framework, no backend simulation — the entire model runs in the browser. Production is a static bundle behind a tiny Express server.

---

## Table of contents

- [Quick start](#quick-start)
- [What it does](#what-it-does)
- [Documentation](#documentation)
- [Repository layout](#repository-layout)
- [Scripts](#scripts)
- [Deployment](#deployment)
- [Contributing](#contributing)

---

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173
```

Press `S` to start the simulation, click an empty space and press `N` to drop a node, drag from a node's right-edge port to another node's left-edge port to connect them. Or pick a [preset](docs/presets.md) from the toolbar to skip the setup.

For the full keyboard / mouse reference, see **[docs/controls.md](docs/controls.md)**.

---

## What it does

DistroSim lets you:

1. **Build** a topology with **18 node types**: clients, load balancers, API servers, databases, replicas, caches, queues, CDNs, key-value stores, object stores, message brokers, search indexes, DNS, service mesh, rate limiters, auth services, WAFs, and config stores.
2. **Run** a 4 Hz tick simulation that sources traffic from clients, propagates it downstream, models per-node capacity and latency, and reports global metrics (availability, p99 latency, throughput, error rate).
3. **Break things** with **63 bespoke chaos events** organized into Infrastructure, Network, Application-level, and Data-layer categories — from instance crashes and AZ failures to cache poisoning, split-brain, GC pauses, LSM compaction storms, and TLS certificate expiry.
4. **Watch** the impact in real time via animated packets, per-node load halos, an event log, and 60-second sparklines.
5. **Save and replay** interesting topologies as JSON.

The simulation is opinionated and approximate — it uses an M/M/1-style queueing approximation for service latency and a simple BFS-from-clients ordering for traffic propagation. It's a tool for *intuition*, not capacity planning. See **[docs/simulation.md](docs/simulation.md)** for the full model.

---

## Documentation

Detailed documentation lives in [`docs/`](docs/). Start here:

| Document                                      | What's in it                                                        |
|-----------------------------------------------|---------------------------------------------------------------------|
| [docs/architecture.md](docs/architecture.md)  | Stack, repo layout, module dependency graph, data flow per frame    |
| [docs/simulation.md](docs/simulation.md)      | What `runTick()` does — traffic sourcing, ordering, latency, p99    |
| [docs/node-types.md](docs/node-types.md)      | All 8 node types: defaults, behavior, capacity, status transitions  |
| [docs/chaos.md](docs/chaos.md)                | Kill, partition, latency, cascade — and how to add new primitives   |
| [docs/presets.md](docs/presets.md)            | Built-in topologies, what they're useful for, how to add your own   |
| [docs/controls.md](docs/controls.md)          | Full keyboard, mouse, toolbar, and sidebar reference                |
| [docs/metrics.md](docs/metrics.md)            | Global metrics, sparklines, severity thresholds, per-node fields    |
| [docs/deployment.md](docs/deployment.md)      | Docker, Railway, Render, Fly.io, Cloud Run, health checks, env vars |
| [docs/development.md](docs/development.md)    | Local dev workflow, typecheck, conventions, where to add features   |

---

## Repository layout

```
DistroSim/
├── README.md                 # ← you are here
├── docs/                     # Detailed documentation (linked above)
├── index.html                # Single-page entry; loads /src/main.ts
├── src/
│   ├── main.ts               # Top-level controller: input + render loop
│   ├── canvas.ts             # Canvas rendering
│   ├── simulation.ts         # Per-tick traffic + latency + error model
│   ├── chaos.ts              # Kill, partition, latency, cascade
│   ├── nodes.ts              # Node creation, hit-testing, ports
│   ├── edges.ts              # Edge geometry (bezier) + hit-testing
│   ├── presets.ts            # Built-in topologies
│   ├── metrics.ts            # Sparkline rendering + formatters
│   └── types.ts              # Shared types and constants
├── server.cts                # Express static server (TS source)
├── server.cjs                # Compiled server (build output)
├── Dockerfile                # Multi-stage Node 20 Alpine
├── Makefile                  # `make help` for dev/build/serve/docker
├── railway.toml              # Railway deploy config
├── vite.config.ts
├── tsconfig.json             # client TS config
└── tsconfig.server.json      # server TS config
```

A walk-through of every module and how they depend on each other lives in **[docs/architecture.md](docs/architecture.md)**.

---

## Scripts

```bash
npm run dev          # Vite dev server with HMR (port 5173)
npm run build        # vite build + tsc -p tsconfig.server.json
npm start            # node server.cjs (port 3000 or $PORT)
npm run preview      # Vite preview of the production build
```

There's also a Makefile with background-server, Docker, and cleanup targets:

```bash
make help            # list every target
make dev-bg          # vite in the background
make serve-bg        # production server in the background
make docker-build    # build the Docker image
make typecheck       # tsc --noEmit
make clean           # remove dist/ server.cjs .pids/
```

Full reference in **[docs/development.md](docs/development.md)**.

---

## Deployment

DistroSim is stateless. Anything that runs `node server.cjs` and forwards `$PORT` works.

```bash
# Local
npm run build && PORT=3000 npm start

# Docker
docker build -t distrosim .
docker run -p 3000:3000 distrosim
```

`railway.toml` is pre-configured for Dockerfile builds and `/healthz` health probes. Render, Fly.io, and Cloud Run all work out of the box.

Full setup notes for each platform: **[docs/deployment.md](docs/deployment.md)**.

---

## Contributing

The codebase is small and approachable: ~10 TypeScript modules, no framework, one mutable state object. Common entry points:

- Adding a node type → [docs/node-types.md](docs/node-types.md) + [docs/simulation.md](docs/simulation.md#extending-the-model)
- Adding a chaos primitive → [docs/chaos.md](docs/chaos.md#adding-a-new-chaos-primitive)
- Adding a preset → [docs/presets.md](docs/presets.md#adding-a-preset)
- Tuning the feel → [docs/development.md](docs/development.md#tune-simulation-feel)

Strict TypeScript everywhere; see **[docs/development.md](docs/development.md#coding-conventions)** for conventions.
