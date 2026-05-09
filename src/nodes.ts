import {
  CATEGORY,
  CATEGORY_COLOR,
  DEFAULT_CONFIG,
  NODE_GLYPH,
  NODE_HEIGHT,
  NODE_WIDTH,
  type NodeType,
  type SimNode,
} from './types';

let idCounter = 0;
export function nextId(prefix = 'n'): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

export function makeNode(type: NodeType, x: number, y: number, label?: string): SimNode {
  return {
    id: nextId('n'),
    type,
    label: label ?? defaultLabel(type),
    x,
    y,
    status: 'healthy',
    loadPct: 0,
    queueDepth: 0,
    errorRate: 0,
    latencyMs: 0,
    throughputRps: 0,
    config: { ...DEFAULT_CONFIG[type] },
    ema: { load: 0, latency: 0, errors: 0 },
  };
}

function defaultLabel(type: NodeType): string {
  const map: Record<NodeType, string> = {
    Client: 'client',
    LoadBalancer: 'lb',
    APIServer: 'api',
    DBPrimary: 'db-primary',
    DBReplica: 'db-replica',
    Cache: 'cache',
    Queue: 'queue',
    CDN: 'cdn',
  };
  return map[type];
}

export function nodeColor(node: SimNode): string {
  return CATEGORY_COLOR[CATEGORY[node.type]];
}

export function nodeGlyph(type: NodeType): string {
  return NODE_GLYPH[type];
}

export interface NodeBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
  cx: number;
  cy: number;
}

export function nodeBounds(node: SimNode): NodeBounds {
  return {
    left: node.x - NODE_WIDTH / 2,
    right: node.x + NODE_WIDTH / 2,
    top: node.y - NODE_HEIGHT / 2,
    bottom: node.y + NODE_HEIGHT / 2,
    cx: node.x,
    cy: node.y,
  };
}

export function pointInNode(node: SimNode, wx: number, wy: number): boolean {
  const b = nodeBounds(node);
  return wx >= b.left && wx <= b.right && wy >= b.top && wy <= b.bottom;
}

export function inputPort(node: SimNode): { x: number; y: number } {
  const b = nodeBounds(node);
  return { x: b.left, y: b.cy };
}

export function outputPort(node: SimNode): { x: number; y: number } {
  const b = nodeBounds(node);
  return { x: b.right, y: b.cy };
}

const PORT_HIT_RADIUS = 10;

export function hitInputPort(node: SimNode, wx: number, wy: number): boolean {
  const p = inputPort(node);
  const dx = p.x - wx;
  const dy = p.y - wy;
  return dx * dx + dy * dy <= PORT_HIT_RADIUS * PORT_HIT_RADIUS;
}

export function hitOutputPort(node: SimNode, wx: number, wy: number): boolean {
  const p = outputPort(node);
  const dx = p.x - wx;
  const dy = p.y - wy;
  return dx * dx + dy * dy <= PORT_HIT_RADIUS * PORT_HIT_RADIUS;
}

export const ALL_NODE_TYPES: NodeType[] = [
  'Client',
  'LoadBalancer',
  'APIServer',
  'DBPrimary',
  'DBReplica',
  'Cache',
  'Queue',
  'CDN',
];
