export type NodeType =
  | 'Client'
  | 'LoadBalancer'
  | 'APIServer'
  | 'AppServer'
  | 'DBPrimary'
  | 'DBReplica'
  | 'Cache'
  | 'Queue'
  | 'CDN'
  // New types
  | 'KeyValueStore'
  | 'ObjectStore'
  | 'MessageBroker'
  | 'SearchIndex'
  | 'DNS'
  | 'ServiceMesh'
  | 'RateLimiter'
  | 'AuthService'
  | 'WAF'
  | 'ConfigStore';

export type NodeCategory = 'client' | 'compute' | 'data' | 'infra';

export type NodeStatus = 'healthy' | 'degraded' | 'down';

export interface NodeEffects {
  // Capacity multiplier (1 = baseline). <1 reduces capacity (CPU throttle, noisy neighbor).
  capacityMul: number;
  // Floor on error percentage (data corruption, FS full, deploy misconfig).
  errorPctFloor: number;
  // Additive latency in ms (lock contention, GC, header bloat, query plan regression).
  latencyAddMs: number;
  // Node frozen (no throughput) until this tick (GC pause, deadlock, metadata lock).
  pausedUntilTick: number;
  // Hardware failure: cannot be recovered by recoverNode.
  permanent: boolean;
  // Attracts >fair share of inbound traffic (hot shard, sticky session).
  hot: boolean;
  // 100% errors at this node (auth failure, TLS, deploy misconfig).
  authFailing: boolean;
  // Two primaries accepting writes; produces conflict errors.
  splitBrain: boolean;
  // Health checks marked failing — load balancers skip this node.
  unhealthy: boolean;
  // For caches/CDN: forced hit rate (cache poisoning = 0, eviction storm = low).
  hitRateOverride: number | null;
  // Availability zone tag for AZ failure grouping.
  zone: string | null;
  // Random crash chance per tick (memory leak escalating to OOM).
  oomChance: number;
  // capacityMul decays by this per tick (memory leak progression).
  capacityDecayPerTick: number;
  // New node ramping up: capacity scales from 0.1 → 1 across slow-start window.
  slowStartUntilTick: number;
  slowStartFromTick: number;
  // LSM compaction storm: degraded IOPS until tick.
  compactionUntilTick: number;
  // Per-tick chance of throughput=0 due to deadlock.
  deadlockChance: number;
  // Connection pool / thread pool hard concurrent cap.
  poolCap: number | null;
  // Logging overload: % of capacity consumed by log floods.
  logFloodPct: number;
  // Replication lag growth multiplier.
  replicationLagBoost: number;
}

export interface EdgeEffects {
  // 0-1: fraction of traffic dropped silently as errors.
  packetLossPct: number;
  // Hard cap on RPS through this edge.
  bandwidthCap: number | null;
  // Edge toggles partitioned every flapPeriodTicks.
  flapping: boolean;
  flapPeriodTicks: number;
  // Traffic enters but never arrives (and is not counted as error).
  blackhole: boolean;
  // 100% errors at edge (TLS handshake/cert failure, NAT failure).
  tlsFailing: boolean;
  // Additive latency from header bloat.
  bloatMs: number;
  // For LB imbalance: relative weight in fair-split (default 1).
  weight: number;
  // DNS lookup adds latency / fails (first-hop edge from gateways).
  dnsFailingUntilTick: number;
  // Routing blackhole window.
  blackholeUntilTick: number;
  // Idle timeout: drops requests if RPS < this for sustained period.
  idleTimeoutBelowRps: number;
}

export function emptyNodeEffects(): NodeEffects {
  return {
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
    zone: null,
    oomChance: 0,
    capacityDecayPerTick: 0,
    slowStartUntilTick: -1,
    slowStartFromTick: -1,
    compactionUntilTick: -1,
    deadlockChance: 0,
    poolCap: null,
    logFloodPct: 0,
    replicationLagBoost: 0,
  };
}

export function emptyEdgeEffects(): EdgeEffects {
  return {
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
  };
}

export interface SimNode {
  id: string;
  type: NodeType;
  label: string;
  x: number;
  y: number;
  status: NodeStatus;
  // Per-tick computed metrics
  loadPct: number;
  queueDepth: number;
  errorRate: number;
  latencyMs: number;
  throughputRps: number;
  // Per-type config
  config: NodeConfig;
  // Smoothed display values (so sparklines look natural)
  ema: { load: number; latency: number; errors: number };
  // Chaos modifiers
  effects: NodeEffects;
}

export interface NodeConfig {
  // Client
  emitRps?: number;
  // Cache / KV / CDN
  hitRate?: number;
  // Queue / MessageBroker
  drainRate?: number;
  capacity?: number;
  // Most service nodes
  capacityRps?: number;
  // Replica
  replicaLagMs?: number;
  // RateLimiter: limit (rps)
  limitRps?: number;
  // AuthService: token cache hit rate
  tokenCacheHitRate?: number;
}

export interface SimEdge {
  id: string;
  fromId: string;
  toId: string;
  throughputRps: number;
  baseLatencyMs: number;
  // Chaos
  partitioned: boolean;
  latencyBoostUntilTick: number;
  latencyBoostMs: number;
  // Live measured load
  measuredRps: number;
  // Chaos modifiers
  effects: EdgeEffects;
}

export type ChaosEventKind =
  | 'kill' | 'partition' | 'latency' | 'cascade' | 'recover' | 'info'
  // Infrastructure
  | 'az-failure' | 'dc-failure' | 'instance-crash' | 'instance-slowdown'
  | 'disk-failure' | 'disk-corruption' | 'iops-saturation' | 'fs-full'
  | 'cpu-throttle' | 'hardware-failure'
  // Network
  | 'cross-region-latency' | 'packet-loss' | 'high-network-latency'
  | 'bandwidth-throttle' | 'connection-flap' | 'lb-imbalance'
  | 'backend-port-unreachable' | 'health-check-fail' | 'health-check-slow'
  | 'tls-cert-expiry' | 'tls-protocol-mismatch' | 'header-bloat'
  | 'sticky-session' | 'slow-start' | 'idle-timeout'
  | 'dns-failure' | 'routing-blackhole' | 'nat-gateway-failure'
  // Application
  | 'memory-leak' | 'oom' | 'thread-pool-exhaust' | 'deadlock'
  | 'gc-pause' | 'config-drift' | 'deploy-misconfig' | 'feature-flag-misfire'
  | 'dependency-timeout' | 'logging-overload'
  // Data
  | 'db-primary-failure' | 'replica-failure' | 'replication-lag'
  | 'split-brain' | 'data-corruption' | 'hot-shard'
  | 'connection-pool-exhaust' | 'lock-contention' | 'query-plan-regression'
  | 'replica-staleness' | 'lsm-compaction' | 'metadata-lock' | 'noisy-neighbor'
  | 'cache-poisoning' | 'cache-eviction' | 'cache-connection-fail'
  | 'cache-auth' | 'cache-oom' | 'cache-frag' | 'cache-persistence-fail'
  | 'cache-replication-fail' | 'cache-cluster-split' | 'cache-script-fail'
  | 'cache-sentinel-fail';

export interface ChaosEvent {
  id: string;
  tick: number;
  realTime: number;
  kind: ChaosEventKind;
  msg: string;
  level: 'error' | 'warn' | 'info';
}

export interface Topology {
  nodes: SimNode[];
  edges: SimEdge[];
}

export interface GlobalMetrics {
  availabilityPct: number;
  p99LatencyMs: number;
  throughputRps: number;
  errorRatePct: number;
  errorBudgetPct: number;
  activeIncidents: number;
}

export interface ViewportState {
  panX: number;
  panY: number;
  zoom: number;
}

export interface Selection {
  nodeId: string | null;
  edgeId: string | null;
}

export type ChaosTargetKind = 'node' | 'edge' | 'two-nodes' | 'global';

export const CATEGORY: Record<NodeType, NodeCategory> = {
  Client: 'client',
  LoadBalancer: 'compute',
  APIServer: 'compute',
  AppServer: 'compute',
  DBPrimary: 'data',
  DBReplica: 'data',
  Cache: 'infra',
  Queue: 'infra',
  CDN: 'infra',
  KeyValueStore: 'data',
  ObjectStore: 'data',
  MessageBroker: 'infra',
  SearchIndex: 'data',
  DNS: 'infra',
  ServiceMesh: 'compute',
  RateLimiter: 'compute',
  AuthService: 'compute',
  WAF: 'compute',
  ConfigStore: 'infra',
};

export const CATEGORY_COLOR: Record<NodeCategory, string> = {
  client: '#378ADD',
  compute: '#1D9E75',
  data: '#BA7517',
  infra: '#888780',
};

export const NODE_GLYPH: Record<NodeType, string> = {
  Client: 'CLI',
  LoadBalancer: 'LB',
  APIServer: 'API',
  AppServer: 'APP',
  DBPrimary: 'DB',
  DBReplica: 'DB·R',
  Cache: 'CACHE',
  Queue: 'MQ',
  CDN: 'CDN',
  KeyValueStore: 'KV',
  ObjectStore: 'S3',
  MessageBroker: 'KAFKA',
  SearchIndex: 'SEARCH',
  DNS: 'DNS',
  ServiceMesh: 'MESH',
  RateLimiter: 'RL',
  AuthService: 'AUTH',
  WAF: 'WAF',
  ConfigStore: 'CFG',
};

export const DEFAULT_CONFIG: Record<NodeType, NodeConfig> = {
  Client: { emitRps: 100 },
  LoadBalancer: { capacityRps: 5000 },
  APIServer: { capacityRps: 800 },
  AppServer: { capacityRps: 500 },
  DBPrimary: { capacityRps: 1000 },
  DBReplica: { capacityRps: 1500, replicaLagMs: 0 },
  Cache: { hitRate: 0.7, capacityRps: 5000 },
  Queue: { drainRate: 500, capacity: 10000 },
  CDN: { hitRate: 0.85, capacityRps: 20000 },
  KeyValueStore: { hitRate: 0.9, capacityRps: 12000 },
  ObjectStore: { capacityRps: 10000 },
  MessageBroker: { drainRate: 2000, capacity: 100000 },
  SearchIndex: { capacityRps: 600 },
  DNS: { capacityRps: 50000 },
  ServiceMesh: { capacityRps: 8000 },
  RateLimiter: { capacityRps: 5000, limitRps: 1000 },
  AuthService: { capacityRps: 2000, tokenCacheHitRate: 0.85 },
  WAF: { capacityRps: 6000 },
  ConfigStore: { capacityRps: 2000, hitRate: 0.95 },
};

export const NODE_RADIUS = 38;
export const NODE_WIDTH = 110;
export const NODE_HEIGHT = 64;
