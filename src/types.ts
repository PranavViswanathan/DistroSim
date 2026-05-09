export type NodeType =
  | 'Client'
  | 'LoadBalancer'
  | 'APIServer'
  | 'DBPrimary'
  | 'DBReplica'
  | 'Cache'
  | 'Queue'
  | 'CDN';

export type NodeCategory = 'client' | 'compute' | 'data' | 'infra';

export type NodeStatus = 'healthy' | 'degraded' | 'down';

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
}

export interface NodeConfig {
  // Client
  emitRps?: number;
  // Cache
  hitRate?: number;
  // Queue
  drainRate?: number;
  capacity?: number;
  // DB / API common
  capacityRps?: number;
  // Replica
  replicaLagMs?: number;
}

export interface SimEdge {
  id: string;
  fromId: string;
  toId: string;
  throughputRps: number;
  baseLatencyMs: number;
  // Chaos
  partitioned: boolean;
  latencyBoostUntilTick: number; // tick at which boost ends
  latencyBoostMs: number;
  // Live measured load
  measuredRps: number;
}

export interface ChaosEvent {
  id: string;
  tick: number;
  realTime: number;
  kind: 'kill' | 'partition' | 'latency' | 'cascade' | 'recover' | 'info';
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
  // Pan offset and zoom for canvas-space → screen-space transform.
  // screen = world * zoom + pan
  panX: number;
  panY: number;
  zoom: number;
}

export interface Selection {
  nodeId: string | null;
  edgeId: string | null;
}

export type ChaosMode = 'kill' | 'partition' | 'latency' | 'cascade' | null;

export const CATEGORY: Record<NodeType, NodeCategory> = {
  Client: 'client',
  LoadBalancer: 'compute',
  APIServer: 'compute',
  DBPrimary: 'data',
  DBReplica: 'data',
  Cache: 'infra',
  Queue: 'infra',
  CDN: 'infra',
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
  DBPrimary: 'DB',
  DBReplica: 'DB·R',
  Cache: 'CACHE',
  Queue: 'MQ',
  CDN: 'CDN',
};

export const DEFAULT_CONFIG: Record<NodeType, NodeConfig> = {
  Client: { emitRps: 100 },
  LoadBalancer: { capacityRps: 5000 },
  APIServer: { capacityRps: 800 },
  DBPrimary: { capacityRps: 1000 },
  DBReplica: { capacityRps: 1500, replicaLagMs: 0 },
  Cache: { hitRate: 0.7, capacityRps: 5000 },
  Queue: { drainRate: 500, capacity: 10000 },
  CDN: { hitRate: 0.85, capacityRps: 20000 },
};

export const NODE_RADIUS = 38;
export const NODE_WIDTH = 110;
export const NODE_HEIGHT = 64;
