# DistroSim

Distributed systems simulator with chaos engineering. Vanilla TypeScript + Vite, no UI frameworks.

## Develop

```bash
npm install
npm run dev
```

Vite serves the app at http://localhost:5173.

## Build

```bash
npm run build      # produces dist/ + server.js
npm start          # runs the production server on $PORT (default 3000)
```

## Deploy

### Railway

`railway.toml` is pre-configured for Dockerfile builds. Push to a Railway service and it will pick up the Dockerfile automatically.

### Render / Fly.io / any Docker host

```bash
docker build -t distrosim .
docker run -p 3000:3000 distrosim
```

## Controls

- `N` — open node picker at cursor
- `S` — toggle simulation
- `Space + drag` — pan canvas
- `Scroll` — zoom
- `Backspace` / `Delete` — delete selection
- `Cmd/Ctrl + Z` — undo
- `Double-click` a node — edit label
- Click an output port and drag to an input port to create an edge.

## Topology presets

The "Load preset" dropdown ships four topologies: simple 3-tier, read-replica setup, microservices, and full HA.

## Chaos panel

Right sidebar — kill node, network partition, latency spike, cascade failure. The event log streams events with timestamps.
