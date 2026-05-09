# Simulation model

The simulator runs a discrete-time loop at `ticksPerSec` (default `4`). Each tick, traffic is sourced from `Client` nodes, propagated downstream along non-partitioned edges, transformed by each node's behavior, and accounted into per-node and global metrics.

The full implementation lives in [`src/simulation.ts`](../src/simulation.ts).

## Core types

```ts
interface SimState {
  topology: Topology;
  running: boolean;
  tick: number;
  ticksPerSec: number;          // default 4
  packets: Packet[];            // animated dots flying along edges
  events: ChaosEvent[];         // event log (most recent first)
  metrics: GlobalMetrics;
  history: { t: number; m: GlobalMetrics }[];   // last 60s
  latencySamples: number[];     // rolling buffer for p99
}
```

## What happens in one tick

`runTick(state)` does the following, in order:

### 1. Build adjacency

Two maps are built per tick: `outAdj: nodeId → outgoing edges` and `inAdj: nodeId → incoming edges`. These are not cached because edges and nodes can be added, removed, partitioned, or killed at any time.

### 2. Order nodes (BFS from clients)

Traffic is supposed to flow client → … → terminal, so nodes are visited in BFS order starting from every `Client`. Cycles are tolerated: each node is visited at most once per tick. Any node not reachable from a client is appended at the end.

### 3. Source traffic

Every healthy `Client` adds `config.emitRps` to its own `inbound` for this tick. Down clients emit nothing.

### 4. Per-node processing

For each node in BFS order, the simulator computes:

- `inbound` — total RPS entering this node this tick
- `errors` — RPS dropped due to capacity overflow, cycles, or downstream unavailability
- `outRps` — RPS forwarded out of this node
- `terminalRps` — RPS that *terminates* here (e.g., DB read, cache hit)
- `extraLatencyMs` — service latency this node adds

Each node type computes these differently — see [node-types.md](node-types.md) for the full table.

The per-node service latency uses an M/M/1-style queueing approximation:

```ts
function serviceLatency(rps: number, cap: number, base: number): number {
  if (cap <= 0) return base;
  const u = Math.min(0.99, rps / cap);
  return base + base * (u / (1 - u));   // → ∞ as u → 1
}
```

Latency rises gently below 70% utilization and steeply above 90%. This is what makes "saturating" a node visibly painful in the UI.

### 5. Forward traffic to outgoing edges

For each node, the surviving outbound RPS is split equally across edges that are:

- not partitioned
- pointing to a node whose status is not `down`

If there are no such edges and `outRps > 0`, the entire amount is counted as errors (nowhere to go).

Each forwarded share is added to the target's `inbound`, along with a weighted latency contribution `share × (incoming_latency + node_extra_latency + edge_latency)`. Edge latency comes from `edgeEffectiveLatency(edge, tick)` (see [`src/edges.ts`](../src/edges.ts)).

### 6. Sample latency for p99

Whenever traffic terminates at a node, a small number of samples (1–20, scaled by `terminalRps`) are pushed to a rolling buffer of the last 600 latency observations. p99 is computed by sorting that buffer and taking the value at index `floor(0.99 × len)`.

### 7. Update node status

After processing, a node's status is recomputed:

| Condition                                  | Status      |
|--------------------------------------------|-------------|
| Already `down` (set by chaos)              | `down`      |
| `errPct > 5%` or utilization `> 95%`       | `degraded`  |
| Otherwise                                  | `healthy`   |

Down nodes stay down — only `recoverNode()` clears them.

### 8. Spawn animation packets

For each live (non-partitioned, non-zero) edge, 1–3 packets are spawned with a random offset and speed. Color is yellow if RPS > 200, teal otherwise. The total packet count is capped at 280 to keep rendering cheap.

### 9. Compute global metrics

```ts
errorRatePct       = totalErrors / totalRequests * 100
availabilityPct    = max(0, 100 - errorRatePct)   // fallback to 100 / 90 with no traffic
errorBudgetPct     = max(0, 100 - errorRatePct * 10)
p99LatencyMs       = sorted(latencySamples)[floor(len * 0.99)]
throughputRps      = totalRequests - totalErrors
activeIncidents    = count(node.status == 'down') + count(edge.partitioned)
```

These are pushed to `state.history` with a wall-clock timestamp; the buffer is trimmed to 60 seconds.

### 10. Smooth display values (EMA)

Per-node `loadPct`, `errorRate`, and `latencyMs` are each passed through an exponential moving average so sparklines and node halos don't flicker on every tick:

```ts
node.ema.load = ema(node.ema.load, target, 0.4);
```

Different alphas: `0.3` for latency (slower), `0.4` for load and errors (faster).

## Between-tick frames

`advancePackets(state, dt)` is called every animation frame, *not* every tick. It integrates each packet's `t ∈ [0, 1]` along its edge and discards packets that have arrived. Packet speed scales with `state.ticksPerSec / 4` so the animation feels natural at any tick rate.

## Reset

`resetSimMetrics(state)` zeros all per-node runtime counters, the latency buffer, the packet queue, the event history, and the tick counter. Down nodes stay down; healthy/degraded nodes are reset to healthy. Useful for re-running an experiment on the same topology.

## Extending the model

To add a new node type:

1. Add the type to `NodeType` and the lookup tables (`CATEGORY`, `CATEGORY_COLOR`, `NODE_GLYPH`, `DEFAULT_CONFIG`) in [`src/types.ts`](../src/types.ts).
2. Add a label in `defaultLabel()` in [`src/nodes.ts`](../src/nodes.ts).
3. Add a `case` in the big `switch` in `runTick()` in [`src/simulation.ts`](../src/simulation.ts).
4. Pick a glyph and (optionally) a tinted color path in `canvas.ts` if you want to deviate from the category color.

To add a new chaos primitive, see [chaos.md](chaos.md).
