import { inputPort, outputPort } from './nodes';
import { nextId } from './nodes';
import type { SimEdge, SimNode } from './types';

export function makeEdge(from: SimNode, to: SimNode): SimEdge {
  return {
    id: nextId('e'),
    fromId: from.id,
    toId: to.id,
    throughputRps: 1000,
    baseLatencyMs: 5,
    partitioned: false,
    latencyBoostUntilTick: -1,
    latencyBoostMs: 0,
    measuredRps: 0,
  };
}

export function edgeEffectiveLatency(edge: SimEdge, currentTick: number): number {
  if (currentTick < edge.latencyBoostUntilTick) {
    return edge.baseLatencyMs + edge.latencyBoostMs;
  }
  return edge.baseLatencyMs;
}

export interface EdgeGeometry {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  cx: number;
  cy: number;
  // Curved control points for a bezier
  c1x: number;
  c1y: number;
  c2x: number;
  c2y: number;
  length: number;
}

export function edgeGeometry(edge: SimEdge, nodeMap: Map<string, SimNode>): EdgeGeometry | null {
  const from = nodeMap.get(edge.fromId);
  const to = nodeMap.get(edge.toId);
  if (!from || !to) return null;

  const a = outputPort(from);
  const b = inputPort(to);

  const dx = b.x - a.x;
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;

  // Smooth bezier — control points biased horizontally so flow reads left→right
  const handle = Math.max(40, Math.abs(dx) * 0.5);
  const c1x = a.x + handle;
  const c1y = a.y;
  const c2x = b.x - handle;
  const c2y = b.y;

  // Approximate length: straight-line is fine for packet timing
  const length = Math.hypot(b.x - a.x, b.y - a.y);

  return {
    x1: a.x,
    y1: a.y,
    x2: b.x,
    y2: b.y,
    cx,
    cy,
    c1x,
    c1y,
    c2x,
    c2y,
    length,
  };
}

// Sample point along a cubic bezier at parameter t ∈ [0, 1]
export function bezierPoint(g: EdgeGeometry, t: number): { x: number; y: number; tan: number } {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const x =
    uu * u * g.x1 + 3 * uu * t * g.c1x + 3 * u * tt * g.c2x + tt * t * g.x2;
  const y =
    uu * u * g.y1 + 3 * uu * t * g.c1y + 3 * u * tt * g.c2y + tt * t * g.y2;
  // Tangent
  const dx =
    3 * uu * (g.c1x - g.x1) +
    6 * u * t * (g.c2x - g.c1x) +
    3 * tt * (g.x2 - g.c2x);
  const dy =
    3 * uu * (g.c1y - g.y1) +
    6 * u * t * (g.c2y - g.c1y) +
    3 * tt * (g.y2 - g.c2y);
  return { x, y, tan: Math.atan2(dy, dx) };
}

// Distance from point to a cubic bezier (sampled approximation), used for hit-test
export function distToEdge(g: EdgeGeometry, px: number, py: number, samples = 24): number {
  let best = Infinity;
  for (let i = 0; i <= samples; i++) {
    const p = bezierPoint(g, i / samples);
    const d = Math.hypot(p.x - px, p.y - py);
    if (d < best) best = d;
  }
  return best;
}
