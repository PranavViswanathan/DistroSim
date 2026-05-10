import { nextId } from './nodes';
import type { SimState } from './simulation';
import { CATEGORY } from './types';
import type {
  ChaosEventKind,
  NodeType,
  SimEdge,
  SimNode,
  Topology,
} from './types';

const EVENT_LOG_LIMIT = 200;

type ChaosLevel = 'error' | 'warn' | 'info';

export type ChaosTarget =
  | { kind: 'node'; nodeId: string }
  | { kind: 'edge'; edgeId: string }
  | { kind: 'two-nodes'; fromId: string; toId: string }
  | { kind: 'global' };

export type ChaosCategory = 'infra' | 'network' | 'app' | 'data';

export interface ChaosCatalogEntry {
  kind: ChaosEventKind;
  category: ChaosCategory;
  label: string;
  glyph: string;
  target: ChaosTarget['kind'];
  description: string;
  // Optional: which node types this can target (UI hint + runtime filter)
  acceptNodeTypes?: NodeType[];
  apply: (state: SimState, target: ChaosTarget) => boolean;
}

export function pushEvent(
  state: SimState,
  kind: ChaosEventKind,
  msg: string,
  level: ChaosLevel = 'info'
): void {
  state.events.unshift({
    id: nextId('ev'),
    tick: state.tick,
    realTime: Date.now(),
    kind,
    msg,
    level,
  });
  if (state.events.length > EVENT_LOG_LIMIT) {
    state.events.length = EVENT_LOG_LIMIT;
  }
}

function findNode(state: SimState, id: string): SimNode | undefined {
  return state.topology.nodes.find(n => n.id === id);
}

function findEdge(state: SimState, id: string): SimEdge | undefined {
  return state.topology.edges.find(e => e.id === id);
}

const STORAGE_TYPES: NodeType[] = [
  'DBPrimary',
  'DBReplica',
  'ObjectStore',
  'KeyValueStore',
  'SearchIndex',
];

const CACHE_TYPES: NodeType[] = ['Cache', 'KeyValueStore', 'CDN'];

// ---------- Existing primitives (preserved API) ----------

export function killNode(state: SimState, nodeId: string): boolean {
  const node = findNode(state, nodeId);
  if (!node) return false;
  if (node.status === 'down') {
    pushEvent(state, 'info', `${node.label} already down`, 'warn');
    return false;
  }
  node.status = 'down';
  node.loadPct = 0;
  node.throughputRps = 0;
  pushEvent(state, 'kill', `killed ${node.type} ${node.label}`, 'error');
  return true;
}

export function recoverNode(state: SimState, nodeId: string): boolean {
  const node = findNode(state, nodeId);
  if (!node) return false;
  if (node.status !== 'down') return false;
  if (node.effects.permanent) {
    pushEvent(state, 'info', `${node.label} hardware failure — replace required`, 'warn');
    return false;
  }
  node.status = 'healthy';
  pushEvent(state, 'recover', `recovered ${node.type} ${node.label}`, 'info');
  return true;
}

export function partitionEdge(state: SimState, edgeId: string): boolean {
  const e = findEdge(state, edgeId);
  if (!e) return false;
  if (e.partitioned) {
    e.partitioned = false;
    pushEvent(state, 'recover', `healed partition on edge ${e.id.slice(-4)}`);
    return true;
  }
  e.partitioned = true;
  const from = findNode(state, e.fromId);
  const to = findNode(state, e.toId);
  pushEvent(
    state,
    'partition',
    `partition: ${from?.label ?? '?'} ↛ ${to?.label ?? '?'}`,
    'error'
  );
  return true;
}

export function partitionBetween(state: SimState, fromId: string, toId: string): boolean {
  const e = state.topology.edges.find(
    edge =>
      (edge.fromId === fromId && edge.toId === toId) ||
      (edge.fromId === toId && edge.toId === fromId)
  );
  if (!e) {
    pushEvent(state, 'info', 'no edge between selected nodes', 'warn');
    return false;
  }
  return partitionEdge(state, e.id);
}

export function injectLatencySpike(
  state: SimState,
  edgeId: string,
  ms = 500,
  durationTicks = 40
): boolean {
  const e = findEdge(state, edgeId);
  if (!e) return false;
  e.latencyBoostMs = ms;
  e.latencyBoostUntilTick = state.tick + durationTicks;
  const from = findNode(state, e.fromId);
  const to = findNode(state, e.toId);
  pushEvent(
    state,
    'latency',
    `+${ms}ms latency on ${from?.label ?? '?'} → ${to?.label ?? '?'}`,
    'warn'
  );
  return true;
}

export function cascadeFailure(state: SimState): boolean {
  const candidates = state.topology.nodes.filter(
    n => n.status !== 'down' && n.type !== 'Client'
  );
  if (candidates.length === 0) {
    pushEvent(state, 'info', 'no candidates for cascade failure', 'warn');
    return false;
  }
  candidates.sort((a, b) => b.loadPct - a.loadPct);
  const target = candidates[0]!;
  killNode(state, target.id);
  pushEvent(
    state,
    'cascade',
    `cascade started: most-loaded ${target.label} fell first`,
    'error'
  );
  return true;
}

export function tickChaos(state: SimState): void {
  for (const node of state.topology.nodes) {
    if (node.status === 'down') continue;
    if (node.loadPct > 99 && node.errorRate > 30 && node.type !== 'Client') {
      if (Math.random() < 0.04) {
        killNode(state, node.id);
        pushEvent(state, 'cascade', `secondary failure: ${node.label} overloaded`, 'error');
      }
    }
  }
}

export function exportTopology(topology: Topology): string {
  const slim = {
    nodes: topology.nodes.map(n => ({
      id: n.id,
      type: n.type,
      label: n.label,
      x: Math.round(n.x),
      y: Math.round(n.y),
      config: n.config,
    })),
    edges: topology.edges.map(e => ({
      id: e.id,
      fromId: e.fromId,
      toId: e.toId,
      throughputRps: e.throughputRps,
      baseLatencyMs: e.baseLatencyMs,
    })),
  };
  return JSON.stringify(slim, null, 2);
}

export function exportMermaid(topology: Topology): string {
  const lines: string[] = ['flowchart LR'];
  if (topology.nodes.length === 0) {
    lines.push('  %% empty topology');
    return lines.join('\n');
  }

  const safeId = (id: string): string => id.replace(/[^A-Za-z0-9_]/g, '_');
  const escapeLabel = (s: string): string =>
    s.replace(/"/g, '&quot;').replace(/\n/g, ' ');

  for (const n of topology.nodes) {
    const label = `${escapeLabel(n.label)} · ${n.type}`;
    lines.push(`  ${safeId(n.id)}["${label}"]:::${CATEGORY[n.type]}`);
  }

  if (topology.edges.length > 0) lines.push('');
  for (const e of topology.edges) {
    lines.push(`  ${safeId(e.fromId)} --> ${safeId(e.toId)}`);
  }

  lines.push('');
  lines.push('  classDef client fill:#378ADD,stroke:#0b0d12,color:#fff');
  lines.push('  classDef compute fill:#1D9E75,stroke:#0b0d12,color:#fff');
  lines.push('  classDef data fill:#BA7517,stroke:#0b0d12,color:#fff');
  lines.push('  classDef infra fill:#888780,stroke:#0b0d12,color:#fff');

  return lines.join('\n');
}

export interface ImportedTopology {
  nodes: Array<Pick<SimNode, 'id' | 'type' | 'label' | 'x' | 'y' | 'config'>>;
  edges: Array<Pick<SimEdge, 'id' | 'fromId' | 'toId' | 'throughputRps' | 'baseLatencyMs'>>;
}

export function importTopology(json: string): ImportedTopology | null {
  try {
    const data = JSON.parse(json);
    if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) return null;
    return data as ImportedTopology;
  } catch {
    return null;
  }
}

// ---------- New bespoke chaos primitives ----------

function nodeOp(
  acceptTypes: NodeType[] | undefined,
  fn: (state: SimState, node: SimNode) => boolean | void
) {
  return (state: SimState, target: ChaosTarget): boolean => {
    if (target.kind !== 'node') return false;
    const node = findNode(state, target.nodeId);
    if (!node) return false;
    if (acceptTypes && !acceptTypes.includes(node.type)) {
      pushEvent(state, 'info', `${node.label} (${node.type}) not a valid target`, 'warn');
      return false;
    }
    return fn(state, node) !== false;
  };
}

function edgeOp(fn: (state: SimState, edge: SimEdge) => boolean | void) {
  return (state: SimState, target: ChaosTarget): boolean => {
    if (target.kind !== 'edge') return false;
    const edge = findEdge(state, target.edgeId);
    if (!edge) return false;
    return fn(state, edge) !== false;
  };
}

function globalOp(fn: (state: SimState) => boolean | void) {
  return (state: SimState, target: ChaosTarget): boolean => {
    if (target.kind !== 'global') return false;
    return fn(state) !== false;
  };
}

// ---------- Infrastructure ----------

function azFailure(state: SimState): void {
  const zones = ['zone-a', 'zone-b', 'zone-c'];
  // Assign zones to nodes that lack one (round-robin)
  let zi = 0;
  for (const n of state.topology.nodes) {
    if (!n.effects.zone) {
      n.effects.zone = zones[zi % zones.length]!;
      zi += 1;
    }
  }
  const targetZone = zones[Math.floor(Math.random() * zones.length)]!;
  let killed = 0;
  for (const n of state.topology.nodes) {
    if (n.effects.zone === targetZone && n.type !== 'Client' && n.status !== 'down') {
      n.status = 'down';
      killed += 1;
    }
  }
  pushEvent(state, 'az-failure', `AZ ${targetZone} failure: ${killed} node(s) down`, 'error');
}

function dcFailure(state: SimState): void {
  let killed = 0;
  for (const n of state.topology.nodes) {
    if (n.type === 'Client' || n.status === 'down') continue;
    n.status = 'down';
    n.effects.permanent = true;
    killed += 1;
  }
  pushEvent(state, 'dc-failure', `data center outage: ${killed} node(s) down (permanent)`, 'error');
}

function instanceCrash(state: SimState, node: SimNode): void {
  if (node.status === 'down') return;
  node.status = 'down';
  pushEvent(state, 'instance-crash', `instance ${node.label} crashed`, 'error');
}

function instanceSlowdown(state: SimState, node: SimNode): void {
  node.effects.capacityMul = Math.min(node.effects.capacityMul, 0.4);
  node.effects.latencyAddMs += 30;
  pushEvent(state, 'instance-slowdown', `${node.label} slowed (capacity ↓60%, +30ms)`, 'warn');
}

function diskFailure(state: SimState, node: SimNode): void {
  node.status = 'down';
  node.effects.permanent = true;
  pushEvent(state, 'disk-failure', `disk failure on ${node.label}`, 'error');
}

function diskCorruption(state: SimState, node: SimNode): void {
  node.effects.errorPctFloor = Math.max(node.effects.errorPctFloor, 15);
  pushEvent(state, 'disk-corruption', `disk corruption: ${node.label} 15% error floor`, 'error');
}

function iopsSaturation(state: SimState, node: SimNode): void {
  node.effects.capacityMul = Math.min(node.effects.capacityMul, 0.3);
  node.effects.latencyAddMs += 80;
  pushEvent(state, 'iops-saturation', `IOPS saturation: ${node.label} (-70% throughput, +80ms)`, 'warn');
}

function fsFull(state: SimState, node: SimNode): void {
  node.effects.errorPctFloor = Math.max(node.effects.errorPctFloor, 70);
  pushEvent(state, 'fs-full', `filesystem full on ${node.label}: 70% writes failing`, 'error');
}

function cpuThrottle(state: SimState, node: SimNode): void {
  node.effects.capacityMul = Math.min(node.effects.capacityMul, 0.25);
  node.effects.latencyAddMs += 20;
  pushEvent(state, 'cpu-throttle', `VM CPU throttle on ${node.label} (-75%)`, 'warn');
}

function hardwareFailure(state: SimState, node: SimNode): void {
  node.status = 'down';
  node.effects.permanent = true;
  pushEvent(state, 'hardware-failure', `host hardware failure: ${node.label} (permanent)`, 'error');
}

// ---------- Network ----------

function crossRegionLatency(state: SimState): void {
  for (const e of state.topology.edges) {
    e.effects.bloatMs = Math.max(e.effects.bloatMs, 100);
  }
  pushEvent(state, 'cross-region-latency', `cross-region: +100ms on all edges`, 'warn');
}

function packetLoss(state: SimState, edge: SimEdge): void {
  edge.effects.packetLossPct = Math.max(edge.effects.packetLossPct, 0.2);
  pushEvent(state, 'packet-loss', `packet loss 20% on edge ${edge.id.slice(-4)}`, 'warn');
}

function highNetworkLatency(state: SimState, edge: SimEdge): void {
  edge.latencyBoostMs = Math.max(edge.latencyBoostMs, 200);
  edge.latencyBoostUntilTick = state.tick + 100;
  pushEvent(state, 'high-network-latency', `+200ms latency on edge ${edge.id.slice(-4)} (25s)`, 'warn');
}

function bandwidthThrottle(state: SimState, edge: SimEdge): void {
  edge.effects.bandwidthCap = 100;
  pushEvent(state, 'bandwidth-throttle', `bandwidth throttled to 100rps on edge ${edge.id.slice(-4)}`, 'warn');
}

function connectionFlap(state: SimState, edge: SimEdge): void {
  edge.effects.flapping = true;
  edge.effects.flapPeriodTicks = 6;
  pushEvent(state, 'connection-flap', `connection flapping on edge ${edge.id.slice(-4)}`, 'warn');
}

function lbImbalance(state: SimState, node: SimNode): void {
  if (node.type !== 'LoadBalancer' && node.type !== 'ServiceMesh') {
    pushEvent(state, 'info', `${node.label} not a load balancer`, 'warn');
    return;
  }
  const outEdges = state.topology.edges.filter(e => e.fromId === node.id);
  if (outEdges.length === 0) return;
  const lucky = outEdges[Math.floor(Math.random() * outEdges.length)]!;
  lucky.effects.weight = 5;
  pushEvent(state, 'lb-imbalance', `${node.label} imbalance: 5x weight on edge ${lucky.id.slice(-4)}`, 'warn');
}

function backendPortUnreachable(state: SimState, edge: SimEdge): void {
  edge.partitioned = true;
  pushEvent(state, 'backend-port-unreachable', `backend port unreachable on edge ${edge.id.slice(-4)}`, 'error');
}

function healthCheckFail(state: SimState, node: SimNode): void {
  node.effects.unhealthy = true;
  pushEvent(state, 'health-check-fail', `health check failing: ${node.label} marked unhealthy`, 'error');
}

function healthCheckSlow(state: SimState, node: SimNode): void {
  node.effects.latencyAddMs += 300;
  pushEvent(state, 'health-check-slow', `health check slow on ${node.label} (+300ms)`, 'warn');
}

function tlsCertExpiry(state: SimState, edge: SimEdge): void {
  edge.effects.tlsFailing = true;
  pushEvent(state, 'tls-cert-expiry', `TLS certificate expired on edge ${edge.id.slice(-4)}`, 'error');
}

function tlsProtocolMismatch(state: SimState, edge: SimEdge): void {
  edge.effects.tlsFailing = true;
  pushEvent(state, 'tls-protocol-mismatch', `TLS protocol mismatch on edge ${edge.id.slice(-4)}`, 'error');
}

function headerBloat(state: SimState, edge: SimEdge): void {
  edge.effects.bloatMs = Math.max(edge.effects.bloatMs, 15);
  pushEvent(state, 'header-bloat', `header bloat +15ms on edge ${edge.id.slice(-4)}`, 'warn');
}

function stickySession(state: SimState, node: SimNode): void {
  node.effects.hot = true;
  pushEvent(state, 'sticky-session', `sticky-session bias: ${node.label} attracting traffic`, 'warn');
}

function slowStart(state: SimState, node: SimNode): void {
  node.effects.slowStartFromTick = state.tick;
  node.effects.slowStartUntilTick = state.tick + 40;
  pushEvent(state, 'slow-start', `slow-start: ${node.label} ramping over 10s`, 'info');
}

function idleTimeout(state: SimState, edge: SimEdge): void {
  edge.effects.idleTimeoutBelowRps = 10;
  pushEvent(state, 'idle-timeout', `idle timeout: edge ${edge.id.slice(-4)} drops below 10rps`, 'warn');
}

function dnsFailure(state: SimState, edge: SimEdge): void {
  edge.effects.dnsFailingUntilTick = state.tick + 40;
  pushEvent(state, 'dns-failure', `DNS resolution failing on edge ${edge.id.slice(-4)} (10s)`, 'error');
}

function routingBlackhole(state: SimState, edge: SimEdge): void {
  edge.effects.blackholeUntilTick = state.tick + 60;
  pushEvent(state, 'routing-blackhole', `routing blackhole on edge ${edge.id.slice(-4)} (15s)`, 'error');
}

function natGatewayFailure(state: SimState, node: SimNode): void {
  // All outgoing edges from this node TLS-fail (simulating egress NAT failure)
  const out = state.topology.edges.filter(e => e.fromId === node.id);
  for (const e of out) e.effects.tlsFailing = true;
  pushEvent(state, 'nat-gateway-failure', `NAT gateway failure: ${out.length} egress edge(s) failing`, 'error');
}

// ---------- Application ----------

function memoryLeak(state: SimState, node: SimNode): void {
  node.effects.capacityDecayPerTick = 0.01;
  node.effects.oomChance = 0.005;
  pushEvent(state, 'memory-leak', `memory leak in ${node.label} (will OOM)`, 'warn');
}

function oomCrash(state: SimState, node: SimNode): void {
  node.status = 'down';
  pushEvent(state, 'oom', `OOM crash on ${node.label}`, 'error');
}

function threadPoolExhaust(state: SimState, node: SimNode): void {
  const base = node.config.capacityRps ?? 1000;
  node.effects.poolCap = Math.round(base * 0.2);
  pushEvent(state, 'thread-pool-exhaust', `thread pool exhausted on ${node.label} (cap ${node.effects.poolCap}rps)`, 'error');
}

function deadlock(state: SimState, node: SimNode): void {
  node.effects.deadlockChance = 0.1;
  pushEvent(state, 'deadlock', `deadlock risk on ${node.label} (10%/tick)`, 'warn');
}

function gcPause(state: SimState, node: SimNode): void {
  node.effects.pausedUntilTick = state.tick + 4;
  pushEvent(state, 'gc-pause', `GC pause on ${node.label} (~1s)`, 'warn');
}

function configDrift(state: SimState, node: SimNode): void {
  node.effects.capacityMul = Math.min(node.effects.capacityMul, 0.7);
  pushEvent(state, 'config-drift', `config drift: ${node.label} running at 70%`, 'warn');
}

function deployMisconfig(state: SimState, node: SimNode): void {
  node.effects.errorPctFloor = Math.max(node.effects.errorPctFloor, 80);
  pushEvent(state, 'deploy-misconfig', `bad deploy on ${node.label}: 80% errors`, 'error');
}

function featureFlagMisfire(state: SimState, node: SimNode): void {
  node.effects.errorPctFloor = Math.max(node.effects.errorPctFloor, 20);
  node.effects.latencyAddMs += 30;
  pushEvent(state, 'feature-flag-misfire', `feature flag misfire on ${node.label}`, 'warn');
}

function dependencyTimeout(state: SimState, edge: SimEdge): void {
  edge.latencyBoostMs = 2000;
  edge.latencyBoostUntilTick = state.tick + 60;
  edge.effects.packetLossPct = Math.max(edge.effects.packetLossPct, 0.3);
  pushEvent(state, 'dependency-timeout', `dependency timeout on edge ${edge.id.slice(-4)} (+2s, 30% loss)`, 'error');
}

function loggingOverload(state: SimState, node: SimNode): void {
  node.effects.logFloodPct = 0.4;
  pushEvent(state, 'logging-overload', `log flood on ${node.label} (-40% capacity)`, 'warn');
}

// ---------- Data ----------

function dbPrimaryFailure(state: SimState, node: SimNode): void {
  node.status = 'down';
  pushEvent(state, 'db-primary-failure', `primary DB ${node.label} failed`, 'error');
}

function replicaFailure(state: SimState, node: SimNode): void {
  node.status = 'down';
  pushEvent(state, 'replica-failure', `replica ${node.label} failed`, 'error');
}

function replicationLag(state: SimState, node: SimNode): void {
  node.effects.replicationLagBoost = 3;
  pushEvent(state, 'replication-lag', `replication lag ↑ on ${node.label}`, 'warn');
}

function splitBrain(state: SimState, node: SimNode): void {
  node.effects.splitBrain = true;
  // Try to also flip another primary if one exists
  const peer = state.topology.nodes.find(
    n => n.id !== node.id && n.type === 'DBPrimary' && n.status !== 'down'
  );
  if (peer) peer.effects.splitBrain = true;
  pushEvent(state, 'split-brain', `split-brain detected: ${node.label}${peer ? ' & ' + peer.label : ''}`, 'error');
}

function dataCorruption(state: SimState, node: SimNode): void {
  node.effects.errorPctFloor = Math.max(node.effects.errorPctFloor, 10);
  pushEvent(state, 'data-corruption', `data corruption on ${node.label} (10% errors)`, 'error');
}

function hotShard(state: SimState, node: SimNode): void {
  node.effects.hot = true;
  pushEvent(state, 'hot-shard', `hot shard: ${node.label} attracting 3x traffic`, 'warn');
}

function connectionPoolExhaust(state: SimState, node: SimNode): void {
  const base = node.config.capacityRps ?? 1000;
  node.effects.poolCap = Math.round(base * 0.25);
  pushEvent(state, 'connection-pool-exhaust', `connection pool exhausted on ${node.label}`, 'error');
}

function lockContention(state: SimState, node: SimNode): void {
  node.effects.latencyAddMs += 80;
  pushEvent(state, 'lock-contention', `lock contention on ${node.label} (+80ms)`, 'warn');
}

function queryPlanRegression(state: SimState, node: SimNode): void {
  node.effects.latencyAddMs += 200;
  node.effects.capacityMul = Math.min(node.effects.capacityMul, 0.5);
  pushEvent(state, 'query-plan-regression', `query plan regression on ${node.label}`, 'error');
}

function replicaStaleness(state: SimState, node: SimNode): void {
  node.effects.replicationLagBoost = 2;
  pushEvent(state, 'replica-staleness', `replica ${node.label} stale`, 'warn');
}

function lsmCompaction(state: SimState, node: SimNode): void {
  node.effects.compactionUntilTick = state.tick + 60;
  pushEvent(state, 'lsm-compaction', `LSM compaction storm on ${node.label} (15s)`, 'warn');
}

function metadataLock(state: SimState, node: SimNode): void {
  node.effects.pausedUntilTick = state.tick + 8;
  pushEvent(state, 'metadata-lock', `metadata lock: ${node.label} stalled (~2s)`, 'error');
}

function noisyNeighbor(state: SimState, node: SimNode): void {
  node.effects.capacityMul = Math.min(node.effects.capacityMul, 0.4);
  pushEvent(state, 'noisy-neighbor', `noisy neighbor on ${node.label} (-60%)`, 'warn');
}

function cachePoisoning(state: SimState, node: SimNode): void {
  node.effects.hitRateOverride = 0;
  pushEvent(state, 'cache-poisoning', `cache poisoning: ${node.label} 0% hit rate`, 'error');
}

function cacheEviction(state: SimState, node: SimNode): void {
  node.effects.hitRateOverride = 0.1;
  pushEvent(state, 'cache-eviction', `cache eviction storm: ${node.label} 10% hit rate`, 'warn');
}

function cacheConnectionFail(state: SimState, node: SimNode): void {
  node.status = 'down';
  pushEvent(state, 'cache-connection-fail', `cache connection lost: ${node.label}`, 'error');
}

function cacheAuth(state: SimState, node: SimNode): void {
  node.effects.authFailing = true;
  pushEvent(state, 'cache-auth', `cache auth failure on ${node.label}`, 'error');
}

function cacheOom(state: SimState, node: SimNode): void {
  node.status = 'down';
  pushEvent(state, 'cache-oom', `cache OOM on ${node.label}`, 'error');
}

function cacheFrag(state: SimState, node: SimNode): void {
  node.effects.capacityMul = Math.min(node.effects.capacityMul, 0.5);
  pushEvent(state, 'cache-frag', `memory fragmentation on ${node.label}`, 'warn');
}

function cachePersistenceFail(state: SimState, node: SimNode): void {
  node.effects.errorPctFloor = Math.max(node.effects.errorPctFloor, 8);
  pushEvent(state, 'cache-persistence-fail', `RDB/AOF persistence failing on ${node.label}`, 'warn');
}

function cacheReplicationFail(state: SimState, node: SimNode): void {
  node.effects.unhealthy = true;
  pushEvent(state, 'cache-replication-fail', `cache replication broken on ${node.label}`, 'error');
}

function cacheClusterSplit(state: SimState, node: SimNode): void {
  node.effects.splitBrain = true;
  pushEvent(state, 'cache-cluster-split', `cache cluster split-brain on ${node.label}`, 'error');
}

function cacheScriptFail(state: SimState, node: SimNode): void {
  node.effects.errorPctFloor = Math.max(node.effects.errorPctFloor, 15);
  node.effects.latencyAddMs += 50;
  pushEvent(state, 'cache-script-fail', `Lua/Redis script failure on ${node.label}`, 'error');
}

function cacheSentinelFail(state: SimState, node: SimNode): void {
  node.effects.unhealthy = true;
  pushEvent(state, 'cache-sentinel-fail', `Sentinel failover failing on ${node.label}`, 'error');
}

// ---------- Catalog ----------

export const CHAOS_CATALOG: ChaosCatalogEntry[] = [
  // Infrastructure
  { kind: 'az-failure', category: 'infra', label: 'Availability zone failure', glyph: 'AZ', target: 'global', description: 'Random AZ goes down', apply: globalOp(azFailure) },
  { kind: 'dc-failure', category: 'infra', label: 'Data center failure', glyph: 'DC', target: 'global', description: 'Whole region goes dark (permanent)', apply: globalOp(dcFailure) },
  { kind: 'instance-crash', category: 'infra', label: 'Instance crash', glyph: '✕', target: 'node', description: 'Single node crashes', apply: nodeOp(undefined, instanceCrash) },
  { kind: 'instance-slowdown', category: 'infra', label: 'Instance slowdown', glyph: '◐', target: 'node', description: 'Capacity ↓60%, +30ms latency', apply: nodeOp(undefined, instanceSlowdown) },
  { kind: 'disk-failure', category: 'infra', label: 'Disk failure', glyph: '⌖', target: 'node', description: 'Storage node permanent failure', acceptNodeTypes: STORAGE_TYPES, apply: nodeOp(STORAGE_TYPES, diskFailure) },
  { kind: 'disk-corruption', category: 'infra', label: 'Disk corruption', glyph: '☣', target: 'node', description: '15% baseline error floor', acceptNodeTypes: STORAGE_TYPES, apply: nodeOp(STORAGE_TYPES, diskCorruption) },
  { kind: 'iops-saturation', category: 'infra', label: 'Storage IOPS saturation', glyph: 'IO', target: 'node', description: 'Throughput -70%, +80ms', acceptNodeTypes: STORAGE_TYPES, apply: nodeOp(STORAGE_TYPES, iopsSaturation) },
  { kind: 'fs-full', category: 'infra', label: 'Filesystem full', glyph: '▮', target: 'node', description: '70% writes fail', acceptNodeTypes: STORAGE_TYPES, apply: nodeOp(STORAGE_TYPES, fsFull) },
  { kind: 'cpu-throttle', category: 'infra', label: 'VM CPU throttle', glyph: '◴', target: 'node', description: 'Capacity -75%, +20ms', apply: nodeOp(undefined, cpuThrottle) },
  { kind: 'hardware-failure', category: 'infra', label: 'Host hardware failure', glyph: '☠', target: 'node', description: 'Permanent — recovery refused', apply: nodeOp(undefined, hardwareFailure) },

  // Network
  { kind: 'partition', category: 'network', label: 'Network partition', glyph: '‖', target: 'two-nodes', description: 'Sever the link between two nodes', apply: (state, target) => {
    if (target.kind !== 'two-nodes') return false;
    return partitionBetween(state, target.fromId, target.toId);
  } },
  { kind: 'cross-region-latency', category: 'network', label: 'Cross-region latency', glyph: '⇄', target: 'global', description: '+100ms on every edge', apply: globalOp(crossRegionLatency) },
  { kind: 'packet-loss', category: 'network', label: 'Packet loss', glyph: '%', target: 'edge', description: '20% packet loss on edge', apply: edgeOp(packetLoss) },
  { kind: 'high-network-latency', category: 'network', label: 'High network latency', glyph: '~', target: 'edge', description: '+200ms for 25s', apply: edgeOp(highNetworkLatency) },
  { kind: 'bandwidth-throttle', category: 'network', label: 'Bandwidth throttle', glyph: 'BW', target: 'edge', description: 'Cap edge to 100rps', apply: edgeOp(bandwidthThrottle) },
  { kind: 'connection-flap', category: 'network', label: 'Connection flapping', glyph: '↯', target: 'edge', description: 'Toggles up/down every 6 ticks', apply: edgeOp(connectionFlap) },
  { kind: 'lb-imbalance', category: 'network', label: 'Load balancer imbalance', glyph: '⇶', target: 'node', description: 'One downstream gets 5x weight', acceptNodeTypes: ['LoadBalancer', 'ServiceMesh'], apply: nodeOp(['LoadBalancer', 'ServiceMesh'], lbImbalance) },
  { kind: 'backend-port-unreachable', category: 'network', label: 'Backend port unreachable', glyph: '⊗', target: 'edge', description: 'Edge partitioned (TCP RST)', apply: edgeOp(backendPortUnreachable) },
  { kind: 'health-check-fail', category: 'network', label: 'Health check failure', glyph: '♥', target: 'node', description: 'LBs stop routing to this node', apply: nodeOp(undefined, healthCheckFail) },
  { kind: 'health-check-slow', category: 'network', label: 'Health check slow', glyph: '⏳', target: 'node', description: '+300ms latency on probes', apply: nodeOp(undefined, healthCheckSlow) },
  { kind: 'tls-cert-expiry', category: 'network', label: 'TLS certificate expiry', glyph: '🔒', target: 'edge', description: '100% errors on edge', apply: edgeOp(tlsCertExpiry) },
  { kind: 'tls-protocol-mismatch', category: 'network', label: 'TLS protocol mismatch', glyph: 'TLS', target: 'edge', description: 'Handshake fails on edge', apply: edgeOp(tlsProtocolMismatch) },
  { kind: 'header-bloat', category: 'network', label: 'Header bloat', glyph: '⌹', target: 'edge', description: '+15ms on every request', apply: edgeOp(headerBloat) },
  { kind: 'sticky-session', category: 'network', label: 'Sticky session', glyph: '◉', target: 'node', description: 'Node attracts disproportionate load', apply: nodeOp(undefined, stickySession) },
  { kind: 'slow-start', category: 'network', label: 'Slow start', glyph: '↗', target: 'node', description: '10s ramp from 10% capacity', apply: nodeOp(undefined, slowStart) },
  { kind: 'idle-timeout', category: 'network', label: 'Idle timeout', glyph: '⌛', target: 'edge', description: 'Drops if RPS < 10', apply: edgeOp(idleTimeout) },
  { kind: 'dns-failure', category: 'network', label: 'DNS resolution failure', glyph: 'DNS', target: 'edge', description: '+250ms on edge for 10s', apply: edgeOp(dnsFailure) },
  { kind: 'routing-blackhole', category: 'network', label: 'Routing blackhole', glyph: '○', target: 'edge', description: 'Traffic enters; nothing arrives', apply: edgeOp(routingBlackhole) },
  { kind: 'nat-gateway-failure', category: 'network', label: 'NAT gateway failure', glyph: 'NAT', target: 'node', description: 'All egress edges fail', apply: nodeOp(undefined, natGatewayFailure) },

  // Application
  { kind: 'memory-leak', category: 'app', label: 'Memory leak', glyph: '🧠', target: 'node', description: 'Capacity decays; eventual OOM', apply: nodeOp(undefined, memoryLeak) },
  { kind: 'oom', category: 'app', label: 'Out-of-memory crash', glyph: '☠', target: 'node', description: 'Immediate crash', apply: nodeOp(undefined, oomCrash) },
  { kind: 'thread-pool-exhaust', category: 'app', label: 'Thread pool exhaustion', glyph: 'TP', target: 'node', description: 'Hard cap at 20% baseline', apply: nodeOp(undefined, threadPoolExhaust) },
  { kind: 'deadlock', category: 'app', label: 'Deadlock', glyph: '⤬', target: 'node', description: '10% per-tick freeze', apply: nodeOp(undefined, deadlock) },
  { kind: 'gc-pause', category: 'app', label: 'GC pause', glyph: '⏸', target: 'node', description: '~1s stop-the-world', apply: nodeOp(undefined, gcPause) },
  { kind: 'config-drift', category: 'app', label: 'Configuration drift', glyph: '⚙', target: 'node', description: 'Quietly running at 70%', apply: nodeOp(undefined, configDrift) },
  { kind: 'deploy-misconfig', category: 'app', label: 'Deployment misconfig', glyph: '🏁', target: 'node', description: '80% errors after bad deploy', apply: nodeOp(undefined, deployMisconfig) },
  { kind: 'feature-flag-misfire', category: 'app', label: 'Feature flag misfire', glyph: '🚩', target: 'node', description: '20% errors + 30ms', apply: nodeOp(undefined, featureFlagMisfire) },
  { kind: 'dependency-timeout', category: 'app', label: 'Dependency timeout', glyph: '⏰', target: 'edge', description: '+2s + 30% packet loss', apply: edgeOp(dependencyTimeout) },
  { kind: 'logging-overload', category: 'app', label: 'Logging system overload', glyph: '📜', target: 'node', description: 'Logs eating 40% of capacity', apply: nodeOp(undefined, loggingOverload) },

  // Data
  { kind: 'db-primary-failure', category: 'data', label: 'Database primary failure', glyph: 'DB', target: 'node', description: 'Primary down', acceptNodeTypes: ['DBPrimary'], apply: nodeOp(['DBPrimary'], dbPrimaryFailure) },
  { kind: 'replica-failure', category: 'data', label: 'Replica failure', glyph: 'R', target: 'node', description: 'Replica down', acceptNodeTypes: ['DBReplica'], apply: nodeOp(['DBReplica'], replicaFailure) },
  { kind: 'replication-lag', category: 'data', label: 'Replication lag', glyph: 'LAG', target: 'node', description: 'Lag amplifier 3x', acceptNodeTypes: ['DBReplica'], apply: nodeOp(['DBReplica'], replicationLag) },
  { kind: 'split-brain', category: 'data', label: 'Split-brain scenario', glyph: '⚡', target: 'node', description: 'Two primaries; conflict errors', acceptNodeTypes: ['DBPrimary'], apply: nodeOp(['DBPrimary'], splitBrain) },
  { kind: 'data-corruption', category: 'data', label: 'Data corruption', glyph: '☣', target: 'node', description: '10% baseline errors', acceptNodeTypes: STORAGE_TYPES, apply: nodeOp(STORAGE_TYPES, dataCorruption) },
  { kind: 'hot-shard', category: 'data', label: 'Hot shard', glyph: '🔥', target: 'node', description: 'Attracts 3x traffic', acceptNodeTypes: STORAGE_TYPES, apply: nodeOp(STORAGE_TYPES, hotShard) },
  { kind: 'connection-pool-exhaust', category: 'data', label: 'Connection pool exhaustion', glyph: 'CP', target: 'node', description: 'Caps connections at 25%', apply: nodeOp(undefined, connectionPoolExhaust) },
  { kind: 'lock-contention', category: 'data', label: 'Lock contention', glyph: '🔒', target: 'node', description: '+80ms on every query', apply: nodeOp(undefined, lockContention) },
  { kind: 'query-plan-regression', category: 'data', label: 'Query plan regression', glyph: 'QP', target: 'node', description: '+200ms, capacity halved', acceptNodeTypes: STORAGE_TYPES, apply: nodeOp(STORAGE_TYPES, queryPlanRegression) },
  { kind: 'replica-staleness', category: 'data', label: 'Replica staleness', glyph: '◌', target: 'node', description: 'Lag amplifier 2x', acceptNodeTypes: ['DBReplica'], apply: nodeOp(['DBReplica'], replicaStaleness) },
  { kind: 'lsm-compaction', category: 'data', label: 'LSM compaction storm', glyph: '⛰', target: 'node', description: '15s of degraded IOPS', acceptNodeTypes: STORAGE_TYPES, apply: nodeOp(STORAGE_TYPES, lsmCompaction) },
  { kind: 'metadata-lock', category: 'data', label: 'Metadata lock', glyph: '🗝', target: 'node', description: '~2s stall', acceptNodeTypes: STORAGE_TYPES, apply: nodeOp(STORAGE_TYPES, metadataLock) },
  { kind: 'noisy-neighbor', category: 'data', label: 'Noisy neighbor', glyph: '🐢', target: 'node', description: 'Capacity -60%', apply: nodeOp(undefined, noisyNeighbor) },
  { kind: 'cache-poisoning', category: 'data', label: 'Cache poisoning', glyph: '☠', target: 'node', description: 'Hit rate forced to 0%', acceptNodeTypes: CACHE_TYPES, apply: nodeOp(CACHE_TYPES, cachePoisoning) },
  { kind: 'cache-eviction', category: 'data', label: 'Cache eviction storm', glyph: '🌪', target: 'node', description: 'Hit rate forced to 10%', acceptNodeTypes: CACHE_TYPES, apply: nodeOp(CACHE_TYPES, cacheEviction) },
  { kind: 'cache-connection-fail', category: 'data', label: 'Cache connection failure', glyph: '✕', target: 'node', description: 'Cache disconnects', acceptNodeTypes: CACHE_TYPES, apply: nodeOp(CACHE_TYPES, cacheConnectionFail) },
  { kind: 'cache-auth', category: 'data', label: 'Cache auth failure', glyph: '🔑', target: 'node', description: 'AUTH command failing', acceptNodeTypes: CACHE_TYPES, apply: nodeOp(CACHE_TYPES, cacheAuth) },
  { kind: 'cache-oom', category: 'data', label: 'Cache OOM', glyph: '💥', target: 'node', description: 'maxmemory exceeded', acceptNodeTypes: CACHE_TYPES, apply: nodeOp(CACHE_TYPES, cacheOom) },
  { kind: 'cache-frag', category: 'data', label: 'Cache memory fragmentation', glyph: '⌗', target: 'node', description: 'Capacity halved', acceptNodeTypes: CACHE_TYPES, apply: nodeOp(CACHE_TYPES, cacheFrag) },
  { kind: 'cache-persistence-fail', category: 'data', label: 'Cache persistence failure', glyph: '💾', target: 'node', description: 'RDB/AOF write failing', acceptNodeTypes: CACHE_TYPES, apply: nodeOp(CACHE_TYPES, cachePersistenceFail) },
  { kind: 'cache-replication-fail', category: 'data', label: 'Cache replication failure', glyph: '🔗', target: 'node', description: 'Replica out of sync', acceptNodeTypes: CACHE_TYPES, apply: nodeOp(CACHE_TYPES, cacheReplicationFail) },
  { kind: 'cache-cluster-split', category: 'data', label: 'Cache cluster split', glyph: '✂', target: 'node', description: 'Cluster split-brain', acceptNodeTypes: CACHE_TYPES, apply: nodeOp(CACHE_TYPES, cacheClusterSplit) },
  { kind: 'cache-script-fail', category: 'data', label: 'Cache script failure', glyph: '📜', target: 'node', description: 'Lua/Redis script error', acceptNodeTypes: CACHE_TYPES, apply: nodeOp(CACHE_TYPES, cacheScriptFail) },
  { kind: 'cache-sentinel-fail', category: 'data', label: 'Cache Sentinel failure', glyph: 'SEN', target: 'node', description: 'Failover broken', acceptNodeTypes: CACHE_TYPES, apply: nodeOp(CACHE_TYPES, cacheSentinelFail) },

  // Existing primitives kept in catalog for UI completeness
  { kind: 'kill', category: 'infra', label: 'Kill node', glyph: '×', target: 'node', description: 'Mark node down', apply: (state, t) => t.kind === 'node' ? killNode(state, t.nodeId) : false },
  { kind: 'latency', category: 'network', label: 'Latency spike', glyph: '~', target: 'edge', description: '+500ms for 10s', apply: (state, t) => t.kind === 'edge' ? injectLatencySpike(state, t.edgeId) : false },
  { kind: 'cascade', category: 'app', label: 'Cascade failure', glyph: '⌁', target: 'global', description: 'Most-loaded node falls; secondaries follow', apply: (state, t) => t.kind === 'global' ? cascadeFailure(state) : false },
];

export const CHAOS_BY_KIND: Map<ChaosEventKind, ChaosCatalogEntry> = (() => {
  const m = new Map<ChaosEventKind, ChaosCatalogEntry>();
  for (const entry of CHAOS_CATALOG) m.set(entry.kind, entry);
  return m;
})();

export function triggerChaos(
  state: SimState,
  kind: ChaosEventKind,
  target: ChaosTarget
): boolean {
  const entry = CHAOS_BY_KIND.get(kind);
  if (!entry) {
    pushEvent(state, 'info', `unknown chaos kind: ${kind}`, 'warn');
    return false;
  }
  return entry.apply(state, target);
}

export function clearNodeEffects(state: SimState, nodeId: string): boolean {
  const node = findNode(state, nodeId);
  if (!node) return false;
  Object.assign(node.effects, {
    capacityMul: 1,
    errorPctFloor: 0,
    latencyAddMs: 0,
    pausedUntilTick: -1,
    permanent: false,
    hot: false,
    authFailing: false,
    splitBrain: false,
    unhealthy: false,
    hitRateOverride: null,
    oomChance: 0,
    capacityDecayPerTick: 0,
    slowStartUntilTick: -1,
    slowStartFromTick: -1,
    compactionUntilTick: -1,
    deadlockChance: 0,
    poolCap: null,
    logFloodPct: 0,
    replicationLagBoost: 0,
  });
  pushEvent(state, 'recover', `cleared effects on ${node.label}`);
  return true;
}

export function clearEdgeEffects(state: SimState, edgeId: string): boolean {
  const edge = findEdge(state, edgeId);
  if (!edge) return false;
  Object.assign(edge.effects, {
    packetLossPct: 0,
    bandwidthCap: null,
    flapping: false,
    flapPeriodTicks: 8,
    blackhole: false,
    tlsFailing: false,
    bloatMs: 0,
    weight: 1,
    dnsFailingUntilTick: -1,
    blackholeUntilTick: -1,
    idleTimeoutBelowRps: 0,
  });
  edge.latencyBoostUntilTick = -1;
  edge.latencyBoostMs = 0;
  pushEvent(state, 'recover', `cleared effects on edge ${edge.id.slice(-4)}`);
  return true;
}
