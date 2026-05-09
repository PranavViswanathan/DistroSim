import { nextId } from './nodes';
import type { SimState } from './simulation';
import type { ChaosEvent, SimEdge, SimNode, Topology } from './types';

const EVENT_LOG_LIMIT = 200;

export function pushEvent(
  state: SimState,
  kind: ChaosEvent['kind'],
  msg: string,
  level: ChaosEvent['level'] = 'info'
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

export function killNode(state: SimState, nodeId: string): boolean {
  const node = state.topology.nodes.find(n => n.id === nodeId);
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
  const node = state.topology.nodes.find(n => n.id === nodeId);
  if (!node) return false;
  if (node.status !== 'down') return false;
  node.status = 'healthy';
  pushEvent(state, 'recover', `recovered ${node.type} ${node.label}`, 'info');
  return true;
}

export function partitionEdge(state: SimState, edgeId: string): boolean {
  const e = state.topology.edges.find(x => x.id === edgeId);
  if (!e) return false;
  if (e.partitioned) {
    e.partitioned = false;
    pushEvent(state, 'recover', `healed partition on edge ${e.id.slice(-4)}`);
    return true;
  }
  e.partitioned = true;
  const from = state.topology.nodes.find(n => n.id === e.fromId);
  const to = state.topology.nodes.find(n => n.id === e.toId);
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

export function injectLatencySpike(state: SimState, edgeId: string, ms = 500, durationTicks = 40): boolean {
  const e = state.topology.edges.find(x => x.id === edgeId);
  if (!e) return false;
  e.latencyBoostMs = ms;
  e.latencyBoostUntilTick = state.tick + durationTicks;
  const from = state.topology.nodes.find(n => n.id === e.fromId);
  const to = state.topology.nodes.find(n => n.id === e.toId);
  pushEvent(
    state,
    'latency',
    `+${ms}ms latency on ${from?.label ?? '?'} → ${to?.label ?? '?'}`,
    'warn'
  );
  return true;
}

export function cascadeFailure(state: SimState): boolean {
  // Pick the node with the highest load that isn't already down or a Client (don't kill the source)
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
  pushEvent(state, 'cascade', `cascade started: most-loaded ${target.label} fell first`, 'error');
  return true;
}

// Kill any edges/nodes that should fail given current state.
// E.g., after a cascade, if a node has 100% load and lost its peer, mark it degraded.
// Called each tick from main.
export function tickChaos(state: SimState): void {
  // If a downstream node loses all its inbound paths and a previously running node
  // is overloaded, mark a "secondary failure" event opportunistically.
  for (const node of state.topology.nodes) {
    if (node.status === 'down') continue;
    if (node.loadPct > 99 && node.errorRate > 30 && node.type !== 'Client') {
      // Tip into failure with low probability per tick
      if (Math.random() < 0.04) {
        killNode(state, node.id);
        pushEvent(state, 'cascade', `secondary failure: ${node.label} overloaded`, 'error');
      }
    }
  }
}

export function exportTopology(topology: Topology): string {
  // Strip runtime-only fields
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
