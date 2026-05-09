# Chaos engineering

DistroSim ships **63 chaos events** organized into four categories. Each event has its own simulation behavior implemented bespoke in [`src/chaos.ts`](../src/chaos.ts) and consumed by [`src/simulation.ts`](../src/simulation.ts) via the `effects` bags on every `SimNode` and `SimEdge`.

The chaos panel in the right sidebar has tabs (Infra / Network / App / Data) that surface the catalog dynamically. Clicking an event activates a targeting mode (node click, edge click, two-node click, or immediate global apply).

## Catalog architecture

Each event is a `ChaosCatalogEntry`:

```ts
interface ChaosCatalogEntry {
  kind: ChaosEventKind;
  category: 'infra' | 'network' | 'app' | 'data';
  label: string;
  glyph: string;
  target: 'node' | 'edge' | 'two-nodes' | 'global';
  description: string;
  acceptNodeTypes?: NodeType[];       // optional filter (e.g. cache-only events)
  apply: (state, target) => boolean;  // bespoke per-event
}
```

`triggerChaos(state, kind, target)` looks the event up in `CHAOS_BY_KIND` and dispatches. The UI builds itself from `CHAOS_CATALOG` so adding a new event takes one entry.

Each event mutates a small set of fields:

- **NodeEffects** (per-node bag): `capacityMul`, `errorPctFloor`, `latencyAddMs`, `pausedUntilTick`, `permanent`, `hot`, `authFailing`, `splitBrain`, `unhealthy`, `hitRateOverride`, `oomChance`, `capacityDecayPerTick`, `slowStartUntil/From`, `compactionUntilTick`, `deadlockChance`, `poolCap`, `logFloodPct`, `replicationLagBoost`, `zone`.
- **EdgeEffects** (per-edge bag): `packetLossPct`, `bandwidthCap`, `flapping`, `flapPeriodTicks`, `blackhole`, `tlsFailing`, `bloatMs`, `weight`, `dnsFailingUntilTick`, `blackholeUntilTick`, `idleTimeoutBelowRps`.

## Catalog

### Infrastructure (10)

| Event                         | Target | Behavior                                                              |
|-------------------------------|--------|-----------------------------------------------------------------------|
| **Availability zone failure** | global | Auto-tags nodes with zones; kills every node in a randomly picked AZ  |
| **Data center failure**       | global | Kills every non-Client node; sets `permanent=true` on all of them     |
| **Instance crash**            | node   | Marks the node `down`                                                 |
| **Instance slowdown**         | node   | `capacityMul=0.4`, `latencyAddMs+=30`                                 |
| **Disk failure**              | node*  | `down + permanent` (storage nodes only)                               |
| **Disk corruption**           | node*  | `errorPctFloor=15` (storage nodes only)                               |
| **Storage IOPS saturation**   | node*  | `capacityMul=0.3`, `latencyAddMs+=80`                                 |
| **Filesystem full**           | node*  | `errorPctFloor=70`                                                    |
| **VM CPU throttle**           | node   | `capacityMul=0.25`, `latencyAddMs+=20`                                |
| **Host hardware failure**     | node   | `down + permanent` (recovery refused)                                 |

`node*` = restricted to storage types: `DBPrimary`, `DBReplica`, `ObjectStore`, `KeyValueStore`, `SearchIndex`.

### Network (19)

| Event                        | Target     | Behavior                                                              |
|------------------------------|------------|-----------------------------------------------------------------------|
| **Network partition**        | two-nodes  | Sets `partitioned=true` on the edge between them                      |
| **Cross-region latency**     | global     | `bloatMs=100` on every edge                                           |
| **Packet loss**              | edge       | `packetLossPct=0.2` (20% of traffic dropped silently as errors)       |
| **High network latency**     | edge       | Existing latency boost: +200ms for 100 ticks (~25s)                   |
| **Bandwidth throttle**       | edge       | `bandwidthCap=100` rps                                                |
| **Connection flapping**      | edge       | `flapping=true`, `flapPeriodTicks=6` (toggles every 1.5s)             |
| **Load balancer imbalance**  | node       | Picks an outgoing edge; sets `weight=5` on it                         |
| **Backend port unreachable** | edge       | Hard partition (alias for partition with distinct kind/log)           |
| **Health check failure**     | node       | `unhealthy=true`; LBs and ServiceMesh skip this node                  |
| **Health check slow**        | node       | `latencyAddMs+=300`                                                   |
| **TLS certificate expiry**   | edge       | `tlsFailing=true` (100% errors at edge)                               |
| **TLS protocol mismatch**    | edge       | `tlsFailing=true` (different log message)                             |
| **Header bloat**             | edge       | `bloatMs=15`                                                          |
| **Sticky session**           | node       | `hot=true` (3x share of inbound)                                      |
| **Slow start**               | node       | Capacity ramps 10% → 100% over 40 ticks (~10s)                        |
| **Idle timeout**             | edge       | `idleTimeoutBelowRps=10` (drops if RPS < 10)                          |
| **DNS resolution failure**   | edge       | `dnsFailingUntilTick=tick+40` (+250ms on edge for 10s)                |
| **Routing blackhole**        | edge       | Traffic enters edge but never arrives, no errors counted (15s)        |
| **NAT gateway failure**      | node       | All outgoing edges from node get `tlsFailing=true`                    |

### Application-level (10)

| Event                         | Target | Behavior                                                              |
|-------------------------------|--------|-----------------------------------------------------------------------|
| **Memory leak**               | node   | `capacityDecayPerTick=0.01`, `oomChance=0.005` per tick               |
| **Out-of-memory crash**       | node   | Immediate `down`                                                      |
| **Thread pool exhaustion**    | node   | `poolCap = baseCap × 0.2` (hard concurrency cap)                      |
| **Deadlock**                  | node   | `deadlockChance=0.1` (10% chance per tick of throughput=0 for 1 tick) |
| **GC pause**                  | node   | `pausedUntilTick=tick+4` (~1s stop-the-world)                         |
| **Configuration drift**       | node   | `capacityMul=0.7` (silently 30% slower)                               |
| **Deployment misconfig**      | node   | `errorPctFloor=80`                                                    |
| **Feature flag misfire**      | node   | `errorPctFloor=20`, `latencyAddMs+=30`                                |
| **Dependency timeout**        | edge   | +2000ms boost for 60 ticks, `packetLossPct=0.3`                       |
| **Logging system overload**   | node   | `logFloodPct=0.4` (40% capacity consumed by log floods)               |

### Data layer (24)

| Event                          | Target | Behavior                                                           |
|--------------------------------|--------|--------------------------------------------------------------------|
| **Database primary failure**   | DBPrimary  | Marks primary `down`                                           |
| **Replica failure**            | DBReplica  | Marks replica `down`                                           |
| **Replication lag**            | DBReplica  | `replicationLagBoost=3` (3x natural lag growth)                |
| **Split-brain scenario**       | DBPrimary  | Sets `splitBrain=true` on this primary + a peer; 30% conflict errors |
| **Data corruption**            | storage    | `errorPctFloor=10`                                             |
| **Hot shard**                  | storage    | `hot=true`; attracts 3x fair share                             |
| **Connection pool exhaust**    | node       | `poolCap = baseCap × 0.25`                                     |
| **Lock contention**            | node       | `latencyAddMs+=80`                                             |
| **Query plan regression**      | storage    | `latencyAddMs+=200`, `capacityMul=0.5`                         |
| **Replica staleness**          | DBReplica  | `replicationLagBoost=2`                                        |
| **LSM compaction storm**       | storage    | `compactionUntilTick=tick+60`; capacity ×0.4, +60-100ms        |
| **Metadata lock**              | storage    | `pausedUntilTick=tick+8` (~2s)                                 |
| **Noisy neighbor**             | node       | `capacityMul=0.4`                                              |
| **Cache poisoning**            | cache      | `hitRateOverride=0`                                            |
| **Cache eviction storm**       | cache      | `hitRateOverride=0.1`                                          |
| **Cache connection failure**   | cache      | Marks cache `down`                                             |
| **Cache auth failure**         | cache      | `authFailing=true` (100% errors at node)                       |
| **Cache OOM**                  | cache      | Marks cache `down` (different log)                             |
| **Cache memory fragmentation** | cache      | `capacityMul=0.5`                                              |
| **Cache persistence failure**  | cache      | `errorPctFloor=8`                                              |
| **Cache replication failure**  | cache      | `unhealthy=true`                                               |
| **Cache cluster split**        | cache      | `splitBrain=true`                                              |
| **Cache script failure**       | cache      | `errorPctFloor=15`, `latencyAddMs+=50`                         |
| **Cache Sentinel failure**     | cache      | `unhealthy=true` (failover broken)                             |

`storage` = `DBPrimary | DBReplica | ObjectStore | KeyValueStore | SearchIndex`. `cache` = `Cache | KeyValueStore | CDN`.

## Targeting

| Target type    | UX                                                          |
|----------------|-------------------------------------------------------------|
| `node`         | Click activates; you click a node next                      |
| `edge`         | Click activates; you click an edge next                     |
| `two-nodes`    | Click activates; you click two nodes that share an edge     |
| `global`       | Click runs immediately, no targeting                        |

If you click a node that doesn't match `acceptNodeTypes`, the event refuses (toast + warning event). Right-click cancels a pending chaos selection.

## Recovery

- **Recover** button (in node inspector): resets `status` to healthy. Refused if `permanent=true`.
- **Clear effects** button (in node and edge inspectors): wipes every effect bag back to defaults, including `permanent`. Use this to clean up after a hardware failure or to reset between experiments.
- **Reset metrics** in the toolbar: zeros counters; topology and effects untouched.
- Latency spikes, DNS failures, routing blackholes, slow starts, LSM compaction, GC pauses, and metadata locks are time-bounded and self-recover after the chaos window.

## Per-tick effects

Some effects need to advance every tick. `applyPerTickEffects` runs at the top of `runTick`:

- **Memory leak progression**: `capacityMul -= capacityDecayPerTick` until floor of 0.05.
- **OOM trigger**: per-tick chance `oomChance` of crashing the node and emitting a synthetic `oom` event.

Cascade failures use the same path as before — `tickChaos()` opportunistically fails secondary nodes that are >99% loaded with >30% errors.

## Adding a new chaos event

1. Add a `ChaosEventKind` value to [`src/types.ts`](../src/types.ts).
2. Implement a function `myEvent(state, target)` in [`src/chaos.ts`](../src/chaos.ts) that:
   - Mutates `node.effects` or `edge.effects` (don't reach into the simulation directly).
   - Calls `pushEvent(state, kind, msg, level)` for the log.
3. Add a `CHAOS_CATALOG` entry with category, label, glyph, target, description, optional `acceptNodeTypes`, and the `apply` wrapper (use `nodeOp`, `edgeOp`, or `globalOp` helpers).
4. The UI picks it up automatically — no DOM edit needed.

If your event needs a brand-new effect dimension that doesn't exist yet, add a field to `NodeEffects`/`EdgeEffects` in `types.ts`, default it in `emptyNodeEffects()`/`emptyEdgeEffects()`, consume it in `runTick`, and clear it in `clearNodeEffects`/`clearEdgeEffects`.
