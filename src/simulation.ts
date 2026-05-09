import { edgeEffectiveLatency } from './edges';
import type {
  ChaosEvent,
  GlobalMetrics,
  SimEdge,
  SimNode,
  Topology,
} from './types';

export interface Packet {
  edgeId: string;
  t: number; // 0..1
  speed: number;
  color: string;
  err?: boolean;
}

export interface SimState {
  topology: Topology;
  running: boolean;
  tick: number;
  ticksPerSec: number;
  packets: Packet[];
  events: ChaosEvent[];
  metrics: GlobalMetrics;
  history: { t: number; m: GlobalMetrics }[];
  // For p99 latency we keep a rolling buffer of recent latency samples
  latencySamples: number[];
}

const HISTORY_SECONDS = 60;
const LATENCY_BUFFER = 600;
const MAX_PACKETS = 280;

export function createSimState(topology: Topology): SimState {
  return {
    topology,
    running: false,
    tick: 0,
    ticksPerSec: 4,
    packets: [],
    events: [],
    metrics: emptyMetrics(),
    history: [],
    latencySamples: [],
  };
}

function emptyMetrics(): GlobalMetrics {
  return {
    availabilityPct: 100,
    p99LatencyMs: 0,
    throughputRps: 0,
    errorRatePct: 0,
    errorBudgetPct: 100,
    activeIncidents: 0,
  };
}

interface NodeRuntime {
  inbound: number;
  errors: number;
  served: number;
  // weighted accumulated latency for inbound traffic (rps * ms)
  latencyAcc: number;
}

interface EdgeRuntime {
  rps: number;
  errs: number;
}

export function runTick(state: SimState): void {
  const { topology } = state;
  state.tick += 1;

  const nodeMap = new Map<string, SimNode>();
  for (const n of topology.nodes) nodeMap.set(n.id, n);

  const outAdj = new Map<string, SimEdge[]>();
  const inAdj = new Map<string, SimEdge[]>();
  for (const n of topology.nodes) {
    outAdj.set(n.id, []);
    inAdj.set(n.id, []);
  }
  for (const e of topology.edges) {
    outAdj.get(e.fromId)?.push(e);
    inAdj.get(e.toId)?.push(e);
  }

  const nrt = new Map<string, NodeRuntime>();
  for (const n of topology.nodes) {
    nrt.set(n.id, { inbound: 0, errors: 0, served: 0, latencyAcc: 0 });
  }
  const ert = new Map<string, EdgeRuntime>();
  for (const e of topology.edges) ert.set(e.id, { rps: 0, errs: 0 });

  // Topological-ish ordering: BFS from each Client. Use a depth limit
  // to tolerate cycles without infinite recursion.
  const order: string[] = [];
  const visited = new Set<string>();
  const queue: string[] = [];
  for (const n of topology.nodes) {
    if (n.type === 'Client') {
      queue.push(n.id);
      visited.add(n.id);
    }
  }
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of outAdj.get(id) ?? []) {
      if (!visited.has(e.toId)) {
        visited.add(e.toId);
        queue.push(e.toId);
      }
    }
  }
  for (const n of topology.nodes) {
    if (!visited.has(n.id)) order.push(n.id);
  }

  // Source: clients emit at their configured RPS
  for (const n of topology.nodes) {
    if (n.type === 'Client' && n.status !== 'down') {
      const rt = nrt.get(n.id)!;
      rt.inbound += n.config.emitRps ?? 0;
    }
  }

  let totalRequests = 0;
  let totalErrors = 0;

  for (const id of order) {
    const node = nodeMap.get(id);
    if (!node) continue;
    const rt = nrt.get(id)!;

    // Latency contribution from inbound edges (avg of weighted source latencies + edge latency)
    // Already accumulated into rt.latencyAcc when traffic was forwarded.
    if (rt.inbound > 0 && node.type === 'Client') totalRequests += rt.inbound;

    if (node.status === 'down') {
      rt.errors += rt.inbound;
      rt.inbound = 0;
      continue;
    }

    let outRps = rt.inbound;
    let extraLatencyMs = 0;
    let terminalRps = 0;
    let terminalLatencyAcc = 0;

    switch (node.type) {
      case 'Client': {
        // Just emits; downstream side handles
        break;
      }
      case 'LoadBalancer': {
        const cap = node.config.capacityRps ?? 5000;
        if (outRps > cap) {
          rt.errors += outRps - cap;
          outRps = cap;
        }
        extraLatencyMs = serviceLatency(outRps, cap, 1);
        break;
      }
      case 'APIServer': {
        const cap = node.config.capacityRps ?? 800;
        if (outRps > cap) {
          rt.errors += outRps - cap;
          outRps = cap;
        }
        // API service latency rises with utilization
        extraLatencyMs = serviceLatency(outRps, cap, 8);
        break;
      }
      case 'Cache': {
        const hit = clamp01(node.config.hitRate ?? 0.7);
        const cap = node.config.capacityRps ?? 5000;
        if (outRps > cap) {
          rt.errors += outRps - cap;
          outRps = cap;
        }
        terminalRps = outRps * hit;
        terminalLatencyAcc = terminalRps * 1; // cache hit ~1ms
        outRps = outRps - terminalRps;
        extraLatencyMs = 1;
        break;
      }
      case 'CDN': {
        const hit = clamp01(node.config.hitRate ?? 0.85);
        const cap = node.config.capacityRps ?? 20000;
        if (outRps > cap) {
          rt.errors += outRps - cap;
          outRps = cap;
        }
        terminalRps = outRps * hit;
        terminalLatencyAcc = terminalRps * 4;
        outRps = outRps - terminalRps;
        extraLatencyMs = 4;
        break;
      }
      case 'Queue': {
        const drain = node.config.drainRate ?? 500;
        const capacity = node.config.capacity ?? 10000;
        const enqueued = outRps;
        // Queue depth grows when inbound > drain; shrinks otherwise
        node.queueDepth = Math.max(
          0,
          Math.min(capacity, node.queueDepth + (enqueued - drain) / state.ticksPerSec)
        );
        // Drop overflow as errors
        if (node.queueDepth >= capacity * 0.99 && enqueued > drain) {
          rt.errors += Math.max(0, enqueued - drain);
        }
        outRps = Math.min(drain, enqueued + node.queueDepth * state.ticksPerSec);
        extraLatencyMs = 2 + (node.queueDepth / drain) * 50;
        break;
      }
      case 'DBPrimary': {
        const cap = node.config.capacityRps ?? 1000;
        if (outRps > cap) {
          rt.errors += outRps - cap;
          outRps = cap;
        }
        terminalRps = outRps;
        extraLatencyMs = serviceLatency(outRps, cap, 12);
        terminalLatencyAcc = outRps * extraLatencyMs;
        outRps = 0;
        break;
      }
      case 'DBReplica': {
        const cap = node.config.capacityRps ?? 1500;
        if (outRps > cap) {
          rt.errors += outRps - cap;
          outRps = cap;
        }
        // Replica lag grows under high write/load, returns to 0 when idle
        const utilization = cap > 0 ? outRps / cap : 0;
        node.config.replicaLagMs = Math.max(
          0,
          (node.config.replicaLagMs ?? 0) * 0.85 + utilization * 80
        );
        terminalRps = outRps;
        extraLatencyMs = serviceLatency(outRps, cap, 6) + (node.config.replicaLagMs ?? 0);
        terminalLatencyAcc = outRps * extraLatencyMs;
        outRps = 0;
        break;
      }
    }

    rt.served = outRps + terminalRps;
    rt.latencyAcc = (rt.inbound > 0 ? (rt.latencyAcc / rt.inbound) : 0); // average inbound latency

    // Forward outRps to outgoing edges (split equally; LB also does round-robin)
    const outEdges = (outAdj.get(id) ?? []).filter(e => {
      if (e.partitioned) return false;
      const target = nodeMap.get(e.toId);
      return !!target && target.status !== 'down';
    });

    if (outRps > 0) {
      if (outEdges.length === 0) {
        // Nowhere to go: drop as errors
        rt.errors += outRps;
        outRps = 0;
      } else {
        const share = outRps / outEdges.length;
        for (const e of outEdges) {
          const er = ert.get(e.id)!;
          er.rps += share;
          const downstreamLatency = rt.latencyAcc + extraLatencyMs + edgeEffectiveLatency(e, state.tick);
          const targetRt = nrt.get(e.toId)!;
          targetRt.inbound += share;
          targetRt.latencyAcc += share * downstreamLatency;
        }
      }
    }

    // Anything terminating here counts toward total throughput
    if (terminalRps > 0) {
      const avgLatency = terminalRps > 0 ? terminalLatencyAcc / terminalRps : 0;
      // Sample a few latency points proportional to terminalRps for p99
      const samplesToAdd = Math.min(20, Math.max(1, Math.round(terminalRps / 50)));
      for (let i = 0; i < samplesToAdd; i++) {
        const jitter = (Math.random() - 0.5) * avgLatency * 0.3;
        state.latencySamples.push(Math.max(0, avgLatency + jitter + (rt.latencyAcc || 0)));
      }
    }

    // Stash node-level metrics for display
    const cap = nodeCapacity(node);
    const utilization = cap > 0 ? rt.inbound / cap : 0;
    const targetLoad = clamp01(utilization) * 100;
    node.ema.load = ema(node.ema.load, targetLoad, 0.4);
    node.loadPct = node.ema.load;
    const errPct = rt.inbound > 0 ? (rt.errors / rt.inbound) * 100 : 0;
    node.ema.errors = ema(node.ema.errors, errPct, 0.4);
    node.errorRate = node.ema.errors;
    const nodeLatency = (rt.latencyAcc || 0) + extraLatencyMs;
    node.ema.latency = ema(node.ema.latency, nodeLatency, 0.3);
    node.latencyMs = node.ema.latency;
    node.throughputRps = rt.served;

    // Status (this branch only runs for non-down nodes — early continue above)
    if (errPct > 5 || utilization > 0.95) node.status = 'degraded';
    else node.status = 'healthy';

    totalErrors += rt.errors;
  }

  // Cap latency buffer
  if (state.latencySamples.length > LATENCY_BUFFER) {
    state.latencySamples.splice(0, state.latencySamples.length - LATENCY_BUFFER);
  }

  // Update edge measured rps (smoothed)
  for (const e of topology.edges) {
    const er = ert.get(e.id)!;
    e.measuredRps = e.measuredRps * 0.6 + er.rps * 0.4;
  }

  // Spawn animation packets for live edges
  spawnPackets(state, ert, nodeMap);

  // Compute global metrics
  const totalServed = totalRequests - totalErrors;
  const errorRatePct = totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0;
  const sortedLat = [...state.latencySamples].sort((a, b) => a - b);
  const p99 =
    sortedLat.length > 0 ? sortedLat[Math.floor(sortedLat.length * 0.99)] ?? 0 : 0;
  const incidents = countIncidents(topology);
  const availability = totalRequests > 0
    ? Math.max(0, 100 - errorRatePct)
    : (topology.nodes.length > 0 && incidents > 0 ? 90 : 100);

  state.metrics = {
    availabilityPct: round2(availability),
    p99LatencyMs: Math.round(p99),
    throughputRps: Math.round(totalServed),
    errorRatePct: round2(errorRatePct),
    errorBudgetPct: round2(Math.max(0, 100 - errorRatePct * 10)),
    activeIncidents: incidents,
  };

  // Push to history
  state.history.push({ t: Date.now(), m: state.metrics });
  const cutoff = Date.now() - HISTORY_SECONDS * 1000;
  while (state.history.length > 0 && state.history[0]!.t < cutoff) {
    state.history.shift();
  }
}

function spawnPackets(
  state: SimState,
  ert: Map<string, { rps: number; errs: number }>,
  _nodeMap: Map<string, SimNode>
): void {
  for (const e of state.topology.edges) {
    if (e.partitioned) continue;
    const er = ert.get(e.id);
    if (!er || er.rps <= 0) continue;
    // Spawn count proportional to rps but bounded
    const count = Math.min(3, Math.max(1, Math.round(Math.log10(er.rps + 1))));
    for (let i = 0; i < count; i++) {
      if (state.packets.length >= MAX_PACKETS) break;
      state.packets.push({
        edgeId: e.id,
        t: Math.random() * 0.05,
        speed: 0.0035 + Math.random() * 0.003,
        color: er.rps > 200 ? '#ffd166' : '#4dd0c8',
      });
    }
  }
}

function nodeCapacity(node: SimNode): number {
  switch (node.type) {
    case 'Client':
      return node.config.emitRps ?? 100;
    case 'Queue':
      return node.config.drainRate ?? 500;
    default:
      return node.config.capacityRps ?? 1000;
  }
}

function serviceLatency(rps: number, cap: number, base: number): number {
  if (cap <= 0) return base;
  const u = Math.min(0.99, rps / cap);
  // M/M/1-style: latency rises sharply near saturation
  return base + base * (u / (1 - u));
}

function ema(prev: number, next: number, alpha: number): number {
  return prev + alpha * (next - prev);
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function countIncidents(topology: Topology): number {
  let n = 0;
  for (const node of topology.nodes) if (node.status === 'down') n += 1;
  for (const e of topology.edges) if (e.partitioned) n += 1;
  return n;
}

export function advancePackets(state: SimState, dt: number): void {
  const live: Packet[] = [];
  for (const p of state.packets) {
    p.t += p.speed * dt * (state.ticksPerSec / 4);
    if (p.t < 1) live.push(p);
  }
  state.packets = live;
}

export function resetSimMetrics(state: SimState): void {
  state.metrics = emptyMetrics();
  state.history = [];
  state.latencySamples = [];
  state.packets = [];
  state.tick = 0;
  for (const n of state.topology.nodes) {
    n.loadPct = 0;
    n.queueDepth = 0;
    n.errorRate = 0;
    n.latencyMs = 0;
    n.throughputRps = 0;
    n.ema = { load: 0, latency: 0, errors: 0 };
    if (n.type === 'DBReplica') n.config.replicaLagMs = 0;
    if (n.status !== 'down') n.status = 'healthy';
  }
  for (const e of state.topology.edges) {
    e.measuredRps = 0;
  }
}
