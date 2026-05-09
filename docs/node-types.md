# Node types

DistroSim ships eight node types, grouped into four categories. Each type has its own per-tick behavior and a small config bag (`NodeConfig`) that you can edit from the right sidebar.

Source of truth: [`src/types.ts`](../src/types.ts) (constants) and [`src/simulation.ts`](../src/simulation.ts) (per-tick math).

## Categories at a glance

| Category | Color     | Members                          |
|----------|-----------|----------------------------------|
| client   | `#378ADD` | Client                           |
| compute  | `#1D9E75` | LoadBalancer, APIServer          |
| data     | `#BA7517` | DBPrimary, DBReplica             |
| infra    | `#888780` | Cache, Queue, CDN                |

Categories control color only; the category does not change behavior.

## Quick reference

| Type          | Glyph   | Default config                                   | Behavior summary                                         |
|---------------|---------|--------------------------------------------------|----------------------------------------------------------|
| Client        | `CLI`   | `emitRps: 100`                                   | Source: emits `emitRps` requests per tick                |
| LoadBalancer  | `LB`    | `capacityRps: 5000`                              | Forwards; tiny service latency; drops above capacity     |
| APIServer     | `API`   | `capacityRps: 800`                               | Forwards; visible service latency under load             |
| DBPrimary     | `DB`    | `capacityRps: 1000`                              | Terminal: serves and replies; latency rises with load    |
| DBReplica     | `DB·R`  | `capacityRps: 1500, replicaLagMs: 0`             | Terminal; tracks replica lag that grows under load       |
| Cache         | `CACHE` | `hitRate: 0.7, capacityRps: 5000`                | Splits: `hitRate` terminates here; rest passes through   |
| Queue         | `MQ`    | `drainRate: 500, capacity: 10000`                | Buffer: depth grows when inbound > drain                 |
| CDN           | `CDN`   | `hitRate: 0.85, capacityRps: 20000`              | Like Cache but bigger; absorbs most read traffic         |

## Detailed behavior

### Client

Source of all traffic. Each healthy client emits `config.emitRps` per tick. Cannot terminate or forward; the simulator only adds to its `inbound` and forwards downstream. Down clients are silent. Setting `emitRps` is the dominant way to load-test a topology.

### LoadBalancer

Forwarder. Takes inbound RPS, drops anything above `capacityRps`, and splits the rest equally across non-partitioned outbound edges. Adds a small service latency (`base = 1`) that climbs near saturation. Most useful when you need to cap a fan-out or simulate one of several LBs failing.

### APIServer

Same forwarding shape as LoadBalancer but with a heavier base latency (`base = 8`). Designed to be the visible bottleneck — set `capacityRps` to the per-instance request budget you care about, and watch what happens at 80%, 95%, 99% utilization.

### Cache

Splits traffic. Inbound is capped to `capacityRps`. Then `hitRate × inbound` terminates here (~1ms latency). The remaining `(1 - hitRate) × inbound` is forwarded downstream — typically into a database. Lowering `hitRate` is a quick way to simulate a cold cache or a thundering-herd cache miss.

### CDN

Same shape as Cache, with bigger defaults (`hitRate: 0.85`, `capacityRps: 20000`) and a slightly higher hit latency (~4ms). Place at the edge of your topology to absorb static traffic before it ever hits the LB.

### Queue

Asynchronous buffer. The model:

```
queueDepth_next = clamp(0, capacity, queueDepth + (enqueued - drainRate) / ticksPerSec)
outRps          = min(drainRate, enqueued + queueDepth × ticksPerSec)
extraLatencyMs  = 2 + (queueDepth / drainRate) × 50
```

If the queue is at ≥99% capacity and inbound exceeds drain, overflow is counted as errors. Backpressure is the only thing that makes latency through a queue interesting — set `drainRate` lower than typical inbound to see depth climb and latency follow.

### DBPrimary

Terminal. All inbound traffic terminates here (no `outRps`). Capped at `capacityRps`; overflow becomes errors. Service latency uses the standard M/M/1 form with `base = 12`. Use to model write-side bottlenecks.

### DBReplica

Terminal. Like DBPrimary but with a tracked `replicaLagMs` field that grows with load and decays when idle:

```ts
replicaLagMs = max(0, replicaLagMs * 0.85 + utilization * 80)
```

The lag is added on top of normal service latency, so a replica under sustained load shows visibly higher tail latency than the primary. Useful for read-replica setups (the [`read-replica`](presets.md#read-replica) preset is built around this).

## Capacity and utilization

Most node types use `nodeCapacity()`:

| Type   | Capacity source     |
|--------|---------------------|
| Client | `emitRps`           |
| Queue  | `drainRate`         |
| Other  | `capacityRps`       |

Utilization is `inbound / capacity`. The display halo on each node is tinted by `loadPct = clamp(utilization, 0, 1) × 100`, smoothed by EMA.

## Status transitions

```
healthy  ──(errPct > 5% OR util > 95%)──▶  degraded
healthy  ──(killNode)─────────────────────▶  down
degraded ──(load returns to normal)──────▶  healthy
down     ──(recoverNode)─────────────────▶  healthy
```

Down is sticky. Degradation flips back to healthy automatically when load and errors fall.

## Editing nodes

- **Sidebar** — Click a node to open its config panel. Edits write directly to `node.config` and take effect on the next tick.
- **Double-click** — Rename a node in place.
- **Drag** — Move a node on the canvas.
- **Delete / Backspace** — Remove the selected node and its incident edges.

See [controls.md](controls.md) for the full input reference.
