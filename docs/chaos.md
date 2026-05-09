# Chaos engineering

Chaos primitives let you break a running topology and watch the metrics react. They live in [`src/chaos.ts`](../src/chaos.ts) and are wired up to the right-hand sidebar in [`src/main.ts`](../src/main.ts).

Every chaos action pushes a `ChaosEvent` to the rolling event log (most recent first, capped at 200 entries). Events are timestamped with both the simulation tick and wall-clock time.

## The four primitives

### Kill node

```ts
killNode(state: SimState, nodeId: string): boolean
```

Marks a node `down`. Its inbound traffic becomes 100% errors immediately, and any downstream edges from it are skipped during forwarding (so traffic that would have flowed through it is also dropped — see [simulation.md §5](simulation.md#5-forward-traffic-to-outgoing-edges)).

- Trying to kill an already-down node logs a warning and returns `false`.
- `recoverNode(state, nodeId)` flips it back to `healthy`.

### Network partition

```ts
partitionEdge(state: SimState, edgeId: string): boolean
partitionBetween(state: SimState, fromId: string, toId: string): boolean
```

Sets `edge.partitioned = true`. The edge stays visible (rendered dashed/red), but no traffic crosses it. Calling `partitionEdge` on an already-partitioned edge *heals* it.

`partitionBetween` is a convenience for "partition the link between these two selected nodes" — it finds an edge in either direction.

### Latency spike

```ts
injectLatencySpike(state: SimState, edgeId: string, ms = 500, durationTicks = 40): boolean
```

Adds `ms` of extra latency on top of the edge's `baseLatencyMs` for the next `durationTicks` ticks (default ~10s at 4 Hz). The boost auto-expires:

```ts
function edgeEffectiveLatency(edge, currentTick) {
  if (currentTick < edge.latencyBoostUntilTick) {
    return edge.baseLatencyMs + edge.latencyBoostMs;
  }
  return edge.baseLatencyMs;
}
```

This is the cleanest way to see p99 react without dropping any traffic.

### Cascade failure

```ts
cascadeFailure(state: SimState): boolean
```

Picks the most-loaded non-`Client` node that's still up and kills it. Then `tickChaos()` (called every tick) opportunistically fails *additional* overloaded nodes:

```ts
if (node.loadPct > 99 && node.errorRate > 30 && random() < 0.04) {
  killNode(node);  // secondary failure
}
```

This is the only chaos primitive that does work *every* tick — the rest are one-shot. The secondary-failure probability is intentionally low so cascades feel like they're spreading rather than instantly cratering the whole topology.

## Event log

Each entry in `state.events` has:

| Field      | Meaning                                                      |
|------------|--------------------------------------------------------------|
| `id`       | Unique event id                                              |
| `tick`     | Simulation tick when it fired                                |
| `realTime` | `Date.now()` at fire time                                    |
| `kind`     | `kill` / `partition` / `latency` / `cascade` / `recover` / `info` |
| `msg`      | Human-readable string shown in the log                       |
| `level`    | `error` / `warn` / `info` (colors the row)                   |

The log is rendered in the right sidebar with the most recent event at top. Buffer is capped at 200 — older events are evicted.

## Recovery

There is no automatic recovery for `kill` or `partition` (latency spikes are the only auto-expiring primitive). To bring things back:

- Click a down node and use **Recover** in the sidebar
- Click a partitioned edge and toggle the partition off (calling `partitionEdge` on a partitioned edge heals it)
- Hit the **Reset metrics** action to zero the metric history without changing topology

## Import / export

`exportTopology()` and `importTopology()` produce/consume a slim JSON shape (just structural fields — no runtime metrics). This is how you save an interesting broken state to share or reproduce later.

```ts
const json = exportTopology(state.topology);
// ... save somewhere ...
const imported = importTopology(json);
```

The import path returns `null` on parse failure rather than throwing, so the UI can show a friendly error.

## Adding a new chaos primitive

1. Add a function to [`src/chaos.ts`](../src/chaos.ts) that mutates `state` and calls `pushEvent`.
2. Add a new `ChaosEvent['kind']` value in [`src/types.ts`](../src/types.ts).
3. If it should run continuously (like `cascadeFailure`'s secondary failures), add a branch to `tickChaos()`.
4. Wire a button in the right sidebar — see existing handlers in [`src/main.ts`](../src/main.ts).

Keep one-shot primitives short and obvious. Anything stochastic should expose its probability as a constant near the top of the file so it's easy to tune.
