# Topology presets

The "Load preset" dropdown in the top toolbar instantiates one of four pre-built topologies. They're a starting point — once loaded, you can edit, extend, and break them like any other topology.

Source: [`src/presets.ts`](../src/presets.ts).

## How presets are built

Every preset is declared as a `PresetSpec` — a list of nodes (with grid coordinates `col`/`row`) and a list of edges (as `[fromIdx, toIdx, opts?]` tuples). `buildPreset()` lays them out on a uniform grid (`spacing.x = 200`, `spacing.y = 110` by default) starting from `origin`. Custom configs are merged into the default `NodeConfig` for that type.

```ts
buildPreset({
  nodes: [
    { type: 'Client', col: 0, row: 0, config: { emitRps: 200 } },
    { type: 'LoadBalancer', col: 1, row: 0 },
    // ...
  ],
  edges: [
    [0, 1, { baseLatencyMs: 5 }],
    // ...
  ],
})
```

This makes new presets cheap to add — just declare nodes and edges; you don't compute pixel coordinates by hand.

## Built-in presets

### Three-tier (`three-tier`)

The classic web-app shape: client → LB → API → DB. One node per tier, in a straight line.

```
Client → LoadBalancer → APIServer → DBPrimary
 200rps                  600 cap     800 cap
```

Use it to:

- See latency rise as you crank `emitRps` past `600` (API saturates first)
- Watch availability drop when you kill any of the four nodes
- Inject latency on the LB→API or API→DB edge to see the full path inflate

### Read replica (`read-replica`)

Adds two `DBReplica` nodes alongside a `DBPrimary`. The API server fans out to all three (primary + 2 replicas) — so most read load lands on replicas.

```
                   ┌──▶ DBPrimary
Client → LB → API ─┼──▶ DBReplica-1
                   └──▶ DBReplica-2
```

Use it to:

- Watch `replicaLagMs` climb on the replicas under sustained read load
- Kill a replica and confirm reads continue (degraded but available)
- Partition the API → DBPrimary edge to simulate write-side isolation

### Microservices (`microservices`)

A gateway LB fans out to three independent services, each backed by its own DB.

```
                       ┌─▶ svc-users   ─▶ db-users
Client → gateway (LB) ─┼─▶ svc-orders  ─▶ db-orders
                       └─▶ svc-billing ─▶ db-billing
```

Use it to:

- Kill `svc-billing` and see only the billing DB go idle (other services unaffected)
- Crank gateway capacity (`8000`) to keep the bottleneck inside services
- Compare per-service tail latency in the sparkline panel

### Full HA (`full-ha`)

The everything-on topology: CDN at the edge, two LBs, three API servers, a Redis cache, primary + 2 replicas, and an events queue.

```
                    ┌─▶ lb-1 ─┐
Client → CDN ──────┤          ├─▶ api-1 ─┐
                    └─▶ lb-2 ─┤          ├─▶ redis ─▶ db-primary, db-replica-1, db-replica-2
                              └─▶ api-2 ─┤
                                          └─▶ events-queue ─▶ db-primary
                                  api-3 ─┘
```

Use it to:

- Run `cascadeFailure` and watch a single overloaded node take down its neighbors
- Partition `redis` ↔ replicas to send all reads to the primary
- Drop the CDN's `hitRate` from `0.85` to `0.3` to simulate a content-cache flush

## Adding a preset

1. Open [`src/presets.ts`](../src/presets.ts).
2. Add a new key to `PresetKey` and a corresponding entry in `PRESETS`.
3. Implement a builder function that returns `buildPreset({...})`.
4. Verify the layout in the UI — adjust `spacing` or `origin` if nodes overlap.

Presets are loaded by replacing `state.topology` with the preset's output, then calling `resetSimMetrics(state)` so old history doesn't bleed into the new shape.
