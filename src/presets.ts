import { makeEdge } from './edges';
import { makeNode } from './nodes';
import type { NodeType, SimEdge, SimNode, Topology } from './types';

export type PresetKey = 'three-tier' | 'read-replica' | 'microservices' | 'full-ha';

export const PRESETS: Record<PresetKey, { name: string; build: () => Topology }> = {
  'three-tier': {
    name: 'Simple 3-tier',
    build: buildThreeTier,
  },
  'read-replica': {
    name: 'Read replica setup',
    build: buildReadReplica,
  },
  microservices: {
    name: 'Microservices',
    build: buildMicroservices,
  },
  'full-ha': {
    name: 'Full HA',
    build: buildFullHA,
  },
};

interface LaidOutNode {
  type: NodeType;
  label?: string;
  col: number;
  row: number;
  config?: Partial<SimNode['config']>;
}

interface PresetSpec {
  nodes: LaidOutNode[];
  edges: Array<[number, number, Partial<Pick<SimEdge, 'baseLatencyMs' | 'throughputRps'>>?]>;
  origin?: { x: number; y: number };
  spacing?: { x: number; y: number };
}

function buildPreset(spec: PresetSpec): Topology {
  const origin = spec.origin ?? { x: 200, y: 240 };
  const spacing = spec.spacing ?? { x: 200, y: 110 };
  const built: SimNode[] = spec.nodes.map(spec => {
    const node = makeNode(
      spec.type,
      origin.x + spec.col * spacing.x,
      origin.y + spec.row * spacing.y,
      spec.label
    );
    if (spec.config) Object.assign(node.config, spec.config);
    return node;
  });
  const edges: SimEdge[] = [];
  for (const [fromIdx, toIdx, opts] of spec.edges) {
    const e = makeEdge(built[fromIdx]!, built[toIdx]!);
    if (opts?.baseLatencyMs !== undefined) e.baseLatencyMs = opts.baseLatencyMs;
    if (opts?.throughputRps !== undefined) e.throughputRps = opts.throughputRps;
    edges.push(e);
  }
  return { nodes: built, edges };
}

function buildThreeTier(): Topology {
  return buildPreset({
    nodes: [
      { type: 'Client', label: 'web-client', col: 0, row: 0, config: { emitRps: 200 } },
      { type: 'LoadBalancer', label: 'lb', col: 1, row: 0 },
      { type: 'APIServer', label: 'api', col: 2, row: 0, config: { capacityRps: 600 } },
      { type: 'DBPrimary', label: 'db', col: 3, row: 0, config: { capacityRps: 800 } },
    ],
    edges: [
      [0, 1, { baseLatencyMs: 5 }],
      [1, 2, { baseLatencyMs: 3 }],
      [2, 3, { baseLatencyMs: 8 }],
    ],
  });
}

function buildReadReplica(): Topology {
  return buildPreset({
    nodes: [
      { type: 'Client', label: 'mobile', col: 0, row: 0, config: { emitRps: 350 } },
      { type: 'LoadBalancer', label: 'lb', col: 1, row: 0 },
      { type: 'APIServer', label: 'api', col: 2, row: 0, config: { capacityRps: 800 } },
      { type: 'DBPrimary', label: 'db-primary', col: 3, row: -1 },
      { type: 'DBReplica', label: 'db-replica-1', col: 3, row: 0 },
      { type: 'DBReplica', label: 'db-replica-2', col: 3, row: 1 },
    ],
    edges: [
      [0, 1, { baseLatencyMs: 5 }],
      [1, 2, { baseLatencyMs: 3 }],
      [2, 3, { baseLatencyMs: 10 }],
      [2, 4, { baseLatencyMs: 12 }],
      [2, 5, { baseLatencyMs: 12 }],
    ],
  });
}

function buildMicroservices(): Topology {
  return buildPreset({
    nodes: [
      { type: 'Client', label: 'client', col: 0, row: 0, config: { emitRps: 400 } },
      { type: 'LoadBalancer', label: 'gateway', col: 1, row: 0, config: { capacityRps: 8000 } },
      { type: 'APIServer', label: 'svc-users', col: 2, row: -1, config: { capacityRps: 600 } },
      { type: 'APIServer', label: 'svc-orders', col: 2, row: 0, config: { capacityRps: 600 } },
      { type: 'APIServer', label: 'svc-billing', col: 2, row: 1, config: { capacityRps: 500 } },
      { type: 'DBPrimary', label: 'db-users', col: 3, row: -1 },
      { type: 'DBPrimary', label: 'db-orders', col: 3, row: 0 },
      { type: 'DBPrimary', label: 'db-billing', col: 3, row: 1 },
    ],
    edges: [
      [0, 1, { baseLatencyMs: 5 }],
      [1, 2, { baseLatencyMs: 3 }],
      [1, 3, { baseLatencyMs: 3 }],
      [1, 4, { baseLatencyMs: 3 }],
      [2, 5, { baseLatencyMs: 8 }],
      [3, 6, { baseLatencyMs: 8 }],
      [4, 7, { baseLatencyMs: 8 }],
    ],
    spacing: { x: 200, y: 130 },
  });
}

function buildFullHA(): Topology {
  return buildPreset({
    nodes: [
      // col 0
      { type: 'Client', label: 'client', col: 0, row: 0, config: { emitRps: 800 } },
      // col 1: CDN
      { type: 'CDN', label: 'cdn', col: 1, row: 0, config: { hitRate: 0.85, capacityRps: 30000 } },
      // col 2: LB cluster
      { type: 'LoadBalancer', label: 'lb-1', col: 2, row: -1, config: { capacityRps: 6000 } },
      { type: 'LoadBalancer', label: 'lb-2', col: 2, row: 1, config: { capacityRps: 6000 } },
      // col 3: API cluster
      { type: 'APIServer', label: 'api-1', col: 3, row: -1.2, config: { capacityRps: 700 } },
      { type: 'APIServer', label: 'api-2', col: 3, row: 0, config: { capacityRps: 700 } },
      { type: 'APIServer', label: 'api-3', col: 3, row: 1.2, config: { capacityRps: 700 } },
      // col 4: cache
      { type: 'Cache', label: 'redis', col: 4, row: 0, config: { hitRate: 0.7, capacityRps: 8000 } },
      // col 5: DBs
      { type: 'DBPrimary', label: 'db-primary', col: 5, row: -1 },
      { type: 'DBReplica', label: 'db-replica-1', col: 5, row: 0 },
      { type: 'DBReplica', label: 'db-replica-2', col: 5, row: 1 },
      // queue branch
      { type: 'Queue', label: 'events-queue', col: 4, row: 1.6, config: { drainRate: 600, capacity: 20000 } },
    ],
    edges: [
      [0, 1, { baseLatencyMs: 8 }],
      [1, 2, { baseLatencyMs: 4 }],
      [1, 3, { baseLatencyMs: 4 }],
      [2, 4, { baseLatencyMs: 3 }],
      [2, 5, { baseLatencyMs: 3 }],
      [3, 5, { baseLatencyMs: 3 }],
      [3, 6, { baseLatencyMs: 3 }],
      [4, 7, { baseLatencyMs: 1 }],
      [5, 7, { baseLatencyMs: 1 }],
      [6, 7, { baseLatencyMs: 1 }],
      [7, 8, { baseLatencyMs: 12 }],
      [7, 9, { baseLatencyMs: 12 }],
      [7, 10, { baseLatencyMs: 12 }],
      [6, 11, { baseLatencyMs: 4 }],
      [11, 8, { baseLatencyMs: 14 }],
    ],
    spacing: { x: 175, y: 95 },
    origin: { x: 140, y: 280 },
  });
}
