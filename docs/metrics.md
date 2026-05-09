# Metrics

DistroSim reports four global metrics, each with a 60-second sparkline. Per-node metrics are surfaced in node halos and the config sidebar.

Source: [`src/metrics.ts`](../src/metrics.ts) and the metric block of `runTick()` in [`src/simulation.ts`](../src/simulation.ts).

## Global metrics

| Metric          | Field             | Unit  | Direction   | "Healthy" threshold |
|-----------------|-------------------|-------|-------------|---------------------|
| Availability    | `availabilityPct` | `%`   | high-good   | ≥ 99.5%             |
| p99 latency     | `p99LatencyMs`    | `ms`  | low-good    | ≤ 100 ms            |
| Throughput      | `throughputRps`   | `rps` | high-good   | n/a (informational) |
| Error rate      | `errorRatePct`    | `%`   | low-good    | < 0.5%              |

`metricSeverity()` maps each value to `'good' | 'warn' | 'bad'` for color coding:

```ts
availabilityPct  ≥ 99.5 → good   ≥ 95  → warn   else → bad
errorRatePct     < 0.5  → good   < 5   → warn   else → bad
p99LatencyMs     ≤ 100  → good   ≤ 500 → warn   else → bad
throughputRps    always good (purely informational)
```

There's also `errorBudgetPct = max(0, 100 - errorRatePct * 10)` and `activeIncidents = downNodes + partitionedEdges` shown alongside.

## How they're computed

```ts
errorRatePct       = totalErrors / totalRequests * 100
availabilityPct    = max(0, 100 - errorRatePct)        // when traffic > 0
p99LatencyMs       = sortedSamples[floor(len * 0.99)]
throughputRps      = totalRequests - totalErrors
errorBudgetPct     = max(0, 100 - errorRatePct * 10)
activeIncidents    = count(node.status == 'down') + count(edge.partitioned)
```

`totalRequests` and `totalErrors` are summed during `runTick`. Latency samples come from terminal nodes (DBs, cache hits, CDN hits) and are kept in a rolling buffer of the last 600 observations.

When there's no traffic at all (every client off, or topology has no clients), availability defaults to 100% (or 90% if there's at least one incident).

## Sparklines

Each global metric has a tiny canvas in the top toolbar that shows the last 60 seconds of values. They redraw every animation frame from `state.history`.

Implementation notes:

- Background grid uses 4 horizontal lines at 25% increments
- Filled gradient under the line uses the metric's color with alpha 0.35 → 0
- Y-axis: `availabilityPct` is fixed-max 100; everything else auto-scales with a 15% headroom
- Each sparkline draws a small dot at the latest sample for at-a-glance current value

## Per-node metrics

Each `SimNode` carries:

```ts
loadPct: number          // 0..100, EMA-smoothed utilization
queueDepth: number       // Queue type only
errorRate: number        // 0..100, EMA-smoothed error pct
latencyMs: number        // EMA-smoothed service latency
throughputRps: number    // last tick's served RPS
ema: { load, latency, errors }   // raw EMA accumulators
```

`loadPct`, `errorRate`, and `latencyMs` are all smoothed before display:

```ts
node.ema.load    = ema(node.ema.load,    targetLoad,    0.4);
node.ema.errors  = ema(node.ema.errors,  errPct,        0.4);
node.ema.latency = ema(node.ema.latency, nodeLatency,   0.3);
```

Latency uses a slower alpha (0.3 vs 0.4) because it tends to be noisier and reads better when slightly damped.

These per-node values are what tints the node's halo and powers the small numbers shown in the config sidebar.

## Reading the simulation through metrics

Some patterns worth knowing:

- **p99 latency climbs but error rate stays flat** → a node is approaching saturation but not dropping requests. Look for utilization > 80% somewhere.
- **Error rate spikes briefly then drops** → typical of a chaos event (kill or partition). Cascade failures show a *staircase* error rate as secondary failures fire.
- **Availability drops below 90% with no `down` nodes** → traffic is being dropped by capacity overflow somewhere. Check node load percentages.
- **Throughput collapses while clients keep emitting** → upstream nodes are dropping traffic before it can be served. Find the first node in the path with utilization > 100%.
- **Replica latency drifts up over time** → `replicaLagMs` accumulating. Reduce read load or scale up replica capacity.
