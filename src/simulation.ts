import { edgeEffectiveLatency, edgeIsBlackholed, edgeIsFlapping } from './edges';
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
  latencyAcc: number;
}

interface EdgeRuntime {
  rps: number;
  errs: number;
}

export function runTick(state: SimState): void {
  const { topology } = state;
  state.tick += 1;

  applyPerTickEffects(state);

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

    if (rt.inbound > 0 && node.type === 'Client') totalRequests += rt.inbound;

    if (node.status === 'down') {
      rt.errors += rt.inbound;
      rt.inbound = 0;
      totalErrors += rt.errors;
      continue;
    }

    // Paused (deadlock, GC pause, metadata lock): all inbound becomes errors
    if (state.tick < node.effects.pausedUntilTick) {
      rt.errors += rt.inbound;
      rt.inbound = 0;
      totalErrors += rt.errors;
      node.throughputRps = 0;
      node.ema.errors = ema(node.ema.errors, 100, 0.4);
      node.errorRate = node.ema.errors;
      node.ema.latency = ema(node.ema.latency, 0, 0.3);
      continue;
    }

    // Random per-tick deadlock chance
    if (node.effects.deadlockChance > 0 && Math.random() < node.effects.deadlockChance) {
      node.effects.pausedUntilTick = state.tick + 1;
      rt.errors += rt.inbound;
      rt.inbound = 0;
      totalErrors += rt.errors;
      continue;
    }

    // Auth failure: 100% errors at this node
    if (node.effects.authFailing) {
      rt.errors += rt.inbound;
      rt.inbound = 0;
      totalErrors += rt.errors;
      node.throughputRps = 0;
      node.ema.errors = ema(node.ema.errors, 100, 0.4);
      node.errorRate = node.ema.errors;
      continue;
    }

    let outRps = rt.inbound;
    let extraLatencyMs = 0;
    let terminalRps = 0;
    let terminalLatencyAcc = 0;

    const effCapMul = effectiveCapacityMul(node, state.tick);
    const cap = baseCapacity(node) * effCapMul;
    const errFloor = node.effects.errorPctFloor;

    switch (node.type) {
      case 'Client': {
        break;
      }
      case 'LoadBalancer': {
        if (outRps > cap) {
          rt.errors += outRps - cap;
          outRps = cap;
        }
        extraLatencyMs = serviceLatency(outRps, cap, 1);
        break;
      }
      case 'APIServer': {
        if (outRps > cap) {
          rt.errors += outRps - cap;
          outRps = cap;
        }
        extraLatencyMs = serviceLatency(outRps, cap, 8);
        break;
      }
      case 'AppServer': {
        if (outRps > cap) {
          rt.errors += outRps - cap;
          outRps = cap;
        }
        extraLatencyMs = serviceLatency(outRps, cap, 18);
        break;
      }
      case 'Cache':
      case 'KeyValueStore':
      case 'CDN': {
        const baseHit =
          node.type === 'CDN' ? 0.85 : node.type === 'KeyValueStore' ? 0.9 : 0.7;
        const hit = clamp01(node.effects.hitRateOverride ?? node.config.hitRate ?? baseHit);
        if (outRps > cap) {
          rt.errors += outRps - cap;
          outRps = cap;
        }
        terminalRps = outRps * hit;
        const hitLat = node.type === 'CDN' ? 4 : node.type === 'KeyValueStore' ? 0.5 : 1;
        terminalLatencyAcc = terminalRps * hitLat;
        outRps = outRps - terminalRps;
        extraLatencyMs = hitLat;
        break;
      }
      case 'Queue':
      case 'MessageBroker': {
        const drain = node.config.drainRate ?? (node.type === 'MessageBroker' ? 2000 : 500);
        const capacity = node.config.capacity ?? (node.type === 'MessageBroker' ? 100000 : 10000);
        const enqueued = outRps;
        node.queueDepth = Math.max(
          0,
          Math.min(capacity, node.queueDepth + (enqueued - drain) / state.ticksPerSec)
        );
        if (node.queueDepth >= capacity * 0.99 && enqueued > drain) {
          rt.errors += Math.max(0, enqueued - drain);
        }
        outRps = Math.min(drain, enqueued + node.queueDepth * state.ticksPerSec);
        const queueBase = node.type === 'MessageBroker' ? 5 : 2;
        extraLatencyMs = queueBase + (node.queueDepth / drain) * 50;
        break;
      }
      case 'DBPrimary': {
        if (outRps > cap) {
          rt.errors += outRps - cap;
          outRps = cap;
        }
        terminalRps = outRps;
        extraLatencyMs = serviceLatency(outRps, cap, 12);
        if (node.effects.splitBrain) {
          rt.errors += outRps * 0.3;
          terminalRps *= 0.7;
        }
        if (state.tick < node.effects.compactionUntilTick) {
          extraLatencyMs += 60;
        }
        terminalLatencyAcc = terminalRps * extraLatencyMs;
        outRps = 0;
        break;
      }
      case 'DBReplica': {
        if (outRps > cap) {
          rt.errors += outRps - cap;
          outRps = cap;
        }
        const utilization = cap > 0 ? outRps / cap : 0;
        const lagBoost = 1 + node.effects.replicationLagBoost;
        node.config.replicaLagMs = Math.max(
          0,
          (node.config.replicaLagMs ?? 0) * 0.85 + utilization * 80 * lagBoost
        );
        terminalRps = outRps;
        extraLatencyMs =
          serviceLatency(outRps, cap, 6) + (node.config.replicaLagMs ?? 0);
        terminalLatencyAcc = outRps * extraLatencyMs;
        outRps = 0;
        break;
      }
      case 'ObjectStore': {
        if (outRps > cap) {
          rt.errors += outRps - cap;
          outRps = cap;
        }
        terminalRps = outRps;
        extraLatencyMs = serviceLatency(outRps, cap, 25);
        if (state.tick < node.effects.compactionUntilTick) {
          extraLatencyMs += 100;
        }
        terminalLatencyAcc = terminalRps * extraLatencyMs;
        outRps = 0;
        break;
      }
      case 'SearchIndex': {
        if (outRps > cap) {
          rt.errors += outRps - cap;
          outRps = cap;
        }
        terminalRps = outRps;
        extraLatencyMs = serviceLatency(outRps, cap, 20);
        terminalLatencyAcc = terminalRps * extraLatencyMs;
        outRps = 0;
        break;
      }
      case 'DNS': {
        if (outRps > cap) {
          rt.errors += outRps - cap;
          outRps = cap;
        }
        extraLatencyMs = 0.5;
        break;
      }
      case 'ServiceMesh': {
        if (outRps > cap) {
          rt.errors += outRps - cap;
          outRps = cap;
        }
        extraLatencyMs = serviceLatency(outRps, cap, 1.5);
        break;
      }
      case 'RateLimiter': {
        const hardLimit = node.config.limitRps ?? 1000;
        if (outRps > hardLimit) {
          rt.errors += outRps - hardLimit;
          outRps = hardLimit;
        }
        if (outRps > cap) {
          rt.errors += outRps - cap;
          outRps = cap;
        }
        extraLatencyMs = 0.3;
        break;
      }
      case 'AuthService': {
        const hit = clamp01(node.config.tokenCacheHitRate ?? 0.85);
        if (outRps > cap) {
          rt.errors += outRps - cap;
          outRps = cap;
        }
        const slow = outRps * (1 - hit);
        const fast = outRps * hit;
        extraLatencyMs =
          (fast * 1 + slow * 25) / Math.max(1, outRps) +
          serviceLatency(outRps, cap, 4);
        break;
      }
      case 'WAF': {
        if (outRps > cap) {
          rt.errors += outRps - cap;
          outRps = cap;
        }
        extraLatencyMs = serviceLatency(outRps, cap, 3);
        break;
      }
      case 'ConfigStore': {
        const hit = clamp01(node.config.hitRate ?? 0.95);
        if (outRps > cap) {
          rt.errors += outRps - cap;
          outRps = cap;
        }
        terminalRps = outRps * hit;
        terminalLatencyAcc = terminalRps * 1.5;
        outRps = outRps - terminalRps;
        extraLatencyMs = 1.5;
        break;
      }
    }

    extraLatencyMs += node.effects.latencyAddMs;

    if (errFloor > 0) {
      const floored = (rt.inbound * errFloor) / 100;
      rt.errors += floored;
      outRps = Math.max(0, outRps - floored);
      terminalRps = Math.max(0, terminalRps - floored * 0.5);
    }

    rt.served = outRps + terminalRps;
    rt.latencyAcc = rt.inbound > 0 ? rt.latencyAcc / rt.inbound : 0;

    const upstreamEdges = (outAdj.get(id) ?? []).filter(e => {
      if (e.partitioned) return false;
      if (edgeIsFlapping(e, state.tick)) return false;
      const target = nodeMap.get(e.toId);
      if (!target || target.status === 'down') return false;
      if (target.effects.unhealthy && (node.type === 'LoadBalancer' || node.type === 'ServiceMesh')) {
        return false;
      }
      return true;
    });

    if (outRps > 0) {
      if (upstreamEdges.length === 0) {
        rt.errors += outRps;
        outRps = 0;
      } else {
        const totalWeight = upstreamEdges.reduce((acc, e) => {
          const target = nodeMap.get(e.toId);
          const hotBoost = target && target.effects.hot ? 3 : 1;
          return acc + e.effects.weight * hotBoost;
        }, 0);
        for (const e of upstreamEdges) {
          const er = ert.get(e.id)!;
          const target = nodeMap.get(e.toId)!;
          const hotBoost = target.effects.hot ? 3 : 1;
          let share = (outRps * e.effects.weight * hotBoost) / totalWeight;

          if (e.effects.tlsFailing) {
            rt.errors += share;
            er.errs += share;
            continue;
          }

          if (e.effects.bandwidthCap !== null && share > e.effects.bandwidthCap) {
            rt.errors += share - e.effects.bandwidthCap;
            share = e.effects.bandwidthCap;
          }

          if (e.effects.packetLossPct > 0) {
            const lost = share * e.effects.packetLossPct;
            rt.errors += lost;
            share -= lost;
          }

          if (
            e.effects.idleTimeoutBelowRps > 0 &&
            share < e.effects.idleTimeoutBelowRps
          ) {
            rt.errors += share;
            er.errs += share;
            share = 0;
          }

          if (edgeIsBlackholed(e, state.tick)) {
            er.rps += share;
            continue;
          }

          er.rps += share;
          const downstreamLatency =
            rt.latencyAcc + extraLatencyMs + edgeEffectiveLatency(e, state.tick);
          const targetRt = nrt.get(e.toId)!;
          targetRt.inbound += share;
          targetRt.latencyAcc += share * downstreamLatency;
        }
      }
    }

    if (terminalRps > 0) {
      const avgLatency = terminalRps > 0 ? terminalLatencyAcc / terminalRps : 0;
      const samplesToAdd = Math.min(20, Math.max(1, Math.round(terminalRps / 50)));
      for (let i = 0; i < samplesToAdd; i++) {
        const jitter = (Math.random() - 0.5) * avgLatency * 0.3;
        state.latencySamples.push(
          Math.max(0, avgLatency + jitter + (rt.latencyAcc || 0))
        );
      }
    }

    const utilization = cap > 0 ? rt.inbound / cap : 0;
    // Client is a source: its "utilization" is always 1 by definition,
    // so don't use it for load/degradation. Show 0% load and skip the trip.
    const isSource = node.type === 'Client';
    const targetLoad = isSource ? 0 : clamp01(utilization) * 100;
    node.ema.load = ema(node.ema.load, targetLoad, 0.4);
    node.loadPct = node.ema.load;
    const errPct = rt.inbound > 0 ? (rt.errors / rt.inbound) * 100 : 0;
    node.ema.errors = ema(node.ema.errors, errPct, 0.4);
    node.errorRate = node.ema.errors;
    const nodeLatency = (rt.latencyAcc || 0) + extraLatencyMs;
    node.ema.latency = ema(node.ema.latency, nodeLatency, 0.3);
    node.latencyMs = node.ema.latency;
    node.throughputRps = isSource ? rt.inbound : rt.served;

    if (node.effects.unhealthy) node.status = 'degraded';
    else if (isSource) node.status = 'healthy';
    else if (errPct > 5 || utilization > 0.95) node.status = 'degraded';
    else node.status = 'healthy';

    totalErrors += rt.errors;
  }

  if (state.latencySamples.length > LATENCY_BUFFER) {
    state.latencySamples.splice(0, state.latencySamples.length - LATENCY_BUFFER);
  }

  for (const e of topology.edges) {
    const er = ert.get(e.id)!;
    e.measuredRps = e.measuredRps * 0.6 + er.rps * 0.4;
  }

  spawnPackets(state, ert, nodeMap);

  const totalServed = totalRequests - totalErrors;
  const errorRatePct = totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0;
  const sortedLat = [...state.latencySamples].sort((a, b) => a - b);
  const p99 =
    sortedLat.length > 0 ? sortedLat[Math.floor(sortedLat.length * 0.99)] ?? 0 : 0;
  const incidents = countIncidents(topology);
  const availability =
    totalRequests > 0
      ? Math.max(0, 100 - errorRatePct)
      : topology.nodes.length > 0 && incidents > 0
        ? 90
        : 100;

  state.metrics = {
    availabilityPct: round2(availability),
    p99LatencyMs: Math.round(p99),
    throughputRps: Math.round(totalServed),
    errorRatePct: round2(errorRatePct),
    errorBudgetPct: round2(Math.max(0, 100 - errorRatePct * 10)),
    activeIncidents: incidents,
  };

  state.history.push({ t: Date.now(), m: state.metrics });
  const cutoff = Date.now() - HISTORY_SECONDS * 1000;
  while (state.history.length > 0 && state.history[0]!.t < cutoff) {
    state.history.shift();
  }
}

function applyPerTickEffects(state: SimState): void {
  for (const node of state.topology.nodes) {
    const eff = node.effects;
    if (eff.capacityDecayPerTick > 0 && eff.capacityMul > 0.05) {
      eff.capacityMul = Math.max(0.05, eff.capacityMul - eff.capacityDecayPerTick);
    }
    if (eff.oomChance > 0 && Math.random() < eff.oomChance && node.status !== 'down') {
      node.status = 'down';
      const ev: ChaosEvent = {
        id: 'auto_' + state.tick + '_' + node.id,
        tick: state.tick,
        realTime: Date.now(),
        kind: 'oom',
        msg: `OOM crash: ${node.label} (memory leak culminated)`,
        level: 'error',
      };
      state.events.unshift(ev);
      if (state.events.length > 200) state.events.length = 200;
    }
  }
}

function effectiveCapacityMul(node: SimNode, tick: number): number {
  let mul = node.effects.capacityMul;
  if (
    node.effects.slowStartUntilTick > tick &&
    node.effects.slowStartFromTick >= 0
  ) {
    const span = Math.max(
      1,
      node.effects.slowStartUntilTick - node.effects.slowStartFromTick
    );
    const progress = clamp01((tick - node.effects.slowStartFromTick) / span);
    mul *= 0.1 + 0.9 * progress;
  }
  if (tick < node.effects.compactionUntilTick) {
    mul *= 0.4;
  }
  if (node.effects.poolCap !== null) {
    const baseCap = baseCapacity(node);
    if (baseCap > 0) {
      mul = Math.min(mul, node.effects.poolCap / baseCap);
    }
  }
  if (node.effects.logFloodPct > 0) {
    mul *= 1 - node.effects.logFloodPct;
  }
  return Math.max(0.05, mul);
}

function spawnPackets(
  state: SimState,
  ert: Map<string, { rps: number; errs: number }>,
  _nodeMap: Map<string, SimNode>
): void {
  for (const e of state.topology.edges) {
    if (e.partitioned) continue;
    if (edgeIsBlackholed(e, state.tick)) continue;
    if (edgeIsFlapping(e, state.tick)) continue;
    const er = ert.get(e.id);
    if (!er || er.rps <= 0) continue;
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

function baseCapacity(node: SimNode): number {
  switch (node.type) {
    case 'Client':
      return node.config.emitRps ?? 100;
    case 'Queue':
    case 'MessageBroker':
      return node.config.drainRate ?? 500;
    default:
      return node.config.capacityRps ?? 1000;
  }
}

function serviceLatency(rps: number, cap: number, base: number): number {
  if (cap <= 0) return base;
  const u = Math.min(0.99, rps / cap);
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
