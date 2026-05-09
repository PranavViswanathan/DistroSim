import { bezierPoint, distToEdge, edgeGeometry } from './edges';
import { hitInputPort, hitOutputPort, inputPort, nodeBounds, nodeColor, nodeGlyph, outputPort, pointInNode } from './nodes';
import type { Packet, SimState } from './simulation';
import {
  CATEGORY,
  type ChaosMode,
  NODE_HEIGHT,
  NODE_WIDTH,
  type Selection,
  type SimEdge,
  type SimNode,
  type ViewportState,
} from './types';

export interface PendingEdge {
  fromNodeId: string;
  cursorWorldX: number;
  cursorWorldY: number;
}

export interface RenderInput {
  state: SimState;
  selection: Selection;
  hover: { nodeId: string | null; edgeId: string | null; port: 'in' | 'out' | null; portNodeId: string | null };
  pendingEdge: PendingEdge | null;
  panActive: boolean;
  spacePressed: boolean;
  chaosMode: ChaosMode;
  partitionFirstNodeId: string | null;
}

const STATUS_COLOR = {
  healthy: '#4ade80',
  degraded: '#facc15',
  down: '#ef4444',
};

export class CanvasRenderer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  minimap: HTMLCanvasElement;
  miniCtx: CanvasRenderingContext2D;
  viewport: ViewportState = { panX: 0, panY: 0, zoom: 1 };
  dpr = window.devicePixelRatio || 1;
  width = 0;
  height = 0;
  miniWidth = 0;
  miniHeight = 0;
  // Animation phase for marching ants
  phase = 0;

  constructor(canvas: HTMLCanvasElement, minimap: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d unavailable');
    this.ctx = ctx;
    this.minimap = minimap;
    const miniCtx = minimap.getContext('2d');
    if (!miniCtx) throw new Error('minimap 2d unavailable');
    this.miniCtx = miniCtx;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => this.resize());
      ro.observe(canvas);
      const minimapParent = minimap.parentElement;
      if (minimapParent) ro.observe(minimapParent);
    }
  }

  resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.width = r.width;
    this.height = r.height;
    this.canvas.width = Math.floor(r.width * this.dpr);
    this.canvas.height = Math.floor(r.height * this.dpr);

    const mr = this.minimap.getBoundingClientRect();
    this.miniWidth = mr.width;
    this.miniHeight = mr.height;
    this.minimap.width = Math.floor(mr.width * this.dpr);
    this.minimap.height = Math.floor(mr.height * this.dpr);
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.viewport.panX) / this.viewport.zoom,
      y: (sy - this.viewport.panY) / this.viewport.zoom,
    };
  }

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return {
      x: wx * this.viewport.zoom + this.viewport.panX,
      y: wy * this.viewport.zoom + this.viewport.panY,
    };
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.screenToWorld(sx, sy);
    this.viewport.zoom = Math.min(3, Math.max(0.25, this.viewport.zoom * factor));
    const after = this.screenToWorld(sx, sy);
    this.viewport.panX += (after.x - before.x) * this.viewport.zoom;
    this.viewport.panY += (after.y - before.y) * this.viewport.zoom;
  }

  panBy(dx: number, dy: number): void {
    this.viewport.panX += dx;
    this.viewport.panY += dy;
  }

  // Hit testing — accepts world coordinates
  pickNode(state: SimState, wx: number, wy: number): SimNode | null {
    for (let i = state.topology.nodes.length - 1; i >= 0; i--) {
      const n = state.topology.nodes[i]!;
      if (pointInNode(n, wx, wy)) return n;
    }
    return null;
  }

  pickPort(state: SimState, wx: number, wy: number): { node: SimNode; port: 'in' | 'out' } | null {
    for (const n of state.topology.nodes) {
      if (hitOutputPort(n, wx, wy)) return { node: n, port: 'out' };
      if (hitInputPort(n, wx, wy)) return { node: n, port: 'in' };
    }
    return null;
  }

  pickEdge(state: SimState, wx: number, wy: number, threshold = 8): SimEdge | null {
    const nodeMap = new Map(state.topology.nodes.map(n => [n.id, n]));
    let best: { edge: SimEdge; d: number } | null = null;
    for (const e of state.topology.edges) {
      const g = edgeGeometry(e, nodeMap);
      if (!g) continue;
      const d = distToEdge(g, wx, wy);
      if (d < threshold && (!best || d < best.d)) {
        best = { edge: e, d };
      }
    }
    return best?.edge ?? null;
  }

  render(input: RenderInput): void {
    const { ctx, viewport } = this;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = '#0b0d12';
    ctx.fillRect(0, 0, this.width, this.height);

    // Grid in world space
    this.drawGrid();

    // Apply viewport transform for world drawing
    ctx.save();
    ctx.translate(viewport.panX, viewport.panY);
    ctx.scale(viewport.zoom, viewport.zoom);

    // Edges first
    this.drawEdges(input);

    // Pending edge being dragged
    if (input.pendingEdge) {
      this.drawPendingEdge(input);
    }

    // Packets
    this.drawPackets(input.state);

    // Nodes on top
    this.drawNodes(input);

    ctx.restore();
    ctx.restore();

    // Minimap (in screen space, separate canvas)
    this.drawMinimap(input.state);

    this.phase = (this.phase + 1) % 1e6;
  }

  private drawGrid(): void {
    const { ctx, viewport } = this;
    const cell = 32;
    const startX = -viewport.panX / viewport.zoom;
    const startY = -viewport.panY / viewport.zoom;
    const endX = (this.width - viewport.panX) / viewport.zoom;
    const endY = (this.height - viewport.panY) / viewport.zoom;

    ctx.save();
    ctx.translate(viewport.panX, viewport.panY);
    ctx.scale(viewport.zoom, viewport.zoom);

    ctx.strokeStyle = 'rgba(255,255,255,0.025)';
    ctx.lineWidth = 1 / viewport.zoom;

    const x0 = Math.floor(startX / cell) * cell;
    const y0 = Math.floor(startY / cell) * cell;

    ctx.beginPath();
    for (let x = x0; x < endX; x += cell) {
      ctx.moveTo(x, startY);
      ctx.lineTo(x, endY);
    }
    for (let y = y0; y < endY; y += cell) {
      ctx.moveTo(startX, y);
      ctx.lineTo(endX, y);
    }
    ctx.stroke();

    // Major grid lines every 4 cells, slightly brighter
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.beginPath();
    const major = cell * 4;
    const mx0 = Math.floor(startX / major) * major;
    const my0 = Math.floor(startY / major) * major;
    for (let x = mx0; x < endX; x += major) {
      ctx.moveTo(x, startY);
      ctx.lineTo(x, endY);
    }
    for (let y = my0; y < endY; y += major) {
      ctx.moveTo(startX, y);
      ctx.lineTo(endX, y);
    }
    ctx.stroke();

    ctx.restore();
  }

  private drawEdges(input: RenderInput): void {
    const { ctx, viewport } = this;
    const nodeMap = new Map(input.state.topology.nodes.map(n => [n.id, n]));
    const phase = this.phase * 0.5;
    for (const e of input.state.topology.edges) {
      const g = edgeGeometry(e, nodeMap);
      if (!g) continue;

      const isSelected = input.selection.edgeId === e.id;
      const isHover = input.hover.edgeId === e.id;
      const partitioned = e.partitioned;
      const boosted = input.state.tick < e.latencyBoostUntilTick;
      const live = input.state.running && e.measuredRps > 1 && !partitioned;

      // Base stroke
      ctx.lineWidth = isSelected ? 2.5 : isHover ? 2 : 1.4;
      let stroke = partitioned ? '#ef4444' : isSelected ? '#4dd0c8' : 'rgba(255,255,255,0.22)';
      if (boosted && !partitioned) stroke = '#facc15';
      ctx.strokeStyle = stroke;

      if (live) {
        ctx.setLineDash([6, 6]);
        ctx.lineDashOffset = -phase;
      } else if (partitioned) {
        ctx.setLineDash([3, 4]);
        ctx.lineDashOffset = 0;
      } else {
        ctx.setLineDash([]);
      }

      ctx.beginPath();
      ctx.moveTo(g.x1, g.y1);
      ctx.bezierCurveTo(g.c1x, g.c1y, g.c2x, g.c2y, g.x2, g.y2);
      ctx.stroke();
      ctx.setLineDash([]);

      // Arrowhead
      const tip = bezierPoint(g, 0.985);
      this.drawArrow(tip.x, tip.y, tip.tan, stroke, isSelected ? 9 : 7);

      // Edge label (rps + latency) if non-trivial
      if (e.measuredRps > 0.5 || isSelected || isHover) {
        const mid = bezierPoint(g, 0.5);
        ctx.font = `${10 / 1}px JetBrains Mono`;
        ctx.fillStyle = isSelected ? '#e6e8ee' : 'rgba(230,232,238,0.6)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const rps = Math.round(e.measuredRps);
        const lat = Math.round(e.baseLatencyMs + (boosted ? e.latencyBoostMs : 0));
        const text = partitioned ? '× partition' : `${rps} rps · ${lat}ms`;
        const tw = ctx.measureText(text).width + 8;
        ctx.fillStyle = 'rgba(11,13,18,0.85)';
        ctx.fillRect(mid.x - tw / 2, mid.y - 8, tw, 14);
        ctx.fillStyle = isSelected ? '#e6e8ee' : 'rgba(230,232,238,0.65)';
        ctx.fillText(text, mid.x, mid.y);
      }
    }

    // Avoid linter warnings
    void viewport;
  }

  private drawArrow(x: number, y: number, angle: number, color: string, size: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-size, -size * 0.55);
    ctx.lineTo(-size * 0.7, 0);
    ctx.lineTo(-size, size * 0.55);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private drawPendingEdge(input: RenderInput): void {
    const ctx = this.ctx;
    const pe = input.pendingEdge!;
    const node = input.state.topology.nodes.find(n => n.id === pe.fromNodeId);
    if (!node) return;
    const a = outputPort(node);
    ctx.strokeStyle = '#4dd0c8';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    const handle = Math.max(40, Math.abs(pe.cursorWorldX - a.x) * 0.5);
    ctx.bezierCurveTo(a.x + handle, a.y, pe.cursorWorldX - handle, pe.cursorWorldY, pe.cursorWorldX, pe.cursorWorldY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#4dd0c8';
    ctx.beginPath();
    ctx.arc(pe.cursorWorldX, pe.cursorWorldY, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawPackets(state: SimState): void {
    const ctx = this.ctx;
    const edgeMap = new Map(state.topology.edges.map(e => [e.id, e]));
    const nodeMap = new Map(state.topology.nodes.map(n => [n.id, n]));
    for (const p of state.packets) {
      const e = edgeMap.get(p.edgeId);
      if (!e) continue;
      const g = edgeGeometry(e, nodeMap);
      if (!g) continue;
      const pt = bezierPoint(g, Math.max(0, Math.min(1, p.t)));
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  private drawNodes(input: RenderInput): void {
    const ctx = this.ctx;
    for (const node of input.state.topology.nodes) {
      this.drawNode(node, input);
      void ctx;
    }
  }

  private drawNode(node: SimNode, input: RenderInput): void {
    const ctx = this.ctx;
    const b = nodeBounds(node);
    const isSelected = input.selection.nodeId === node.id;
    const isHover = input.hover.nodeId === node.id;
    const isPartitionFirst = input.partitionFirstNodeId === node.id;
    const cat = CATEGORY[node.type];
    const baseColor = nodeColor(node);

    // Drop shadow
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(b.left + 2, b.top + 3, NODE_WIDTH, NODE_HEIGHT);

    // Body
    ctx.fillStyle = '#161a23';
    ctx.fillRect(b.left, b.top, NODE_WIDTH, NODE_HEIGHT);

    // Left accent bar (category color)
    ctx.fillStyle = baseColor;
    ctx.fillRect(b.left, b.top, 4, NODE_HEIGHT);

    // Border
    ctx.strokeStyle = isSelected
      ? '#4dd0c8'
      : isPartitionFirst
        ? '#facc15'
        : isHover
          ? 'rgba(255,255,255,0.35)'
          : 'rgba(255,255,255,0.12)';
    ctx.lineWidth = isSelected || isPartitionFirst ? 1.6 : 1;
    ctx.strokeRect(b.left + 0.5, b.top + 0.5, NODE_WIDTH - 1, NODE_HEIGHT - 1);

    // Status indicator (top right)
    const status = node.status;
    const sc = STATUS_COLOR[status];
    ctx.fillStyle = sc;
    ctx.shadowColor = sc;
    ctx.shadowBlur = status === 'down' ? 8 : 4;
    ctx.beginPath();
    ctx.arc(b.right - 10, b.top + 10, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Type glyph (top-left, after accent bar)
    ctx.font = '600 9px JetBrains Mono';
    ctx.fillStyle = baseColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(nodeGlyph(node.type).toUpperCase(), b.left + 10, b.top + 8);

    // Label
    ctx.font = '500 11px JetBrains Mono';
    ctx.fillStyle = '#e6e8ee';
    ctx.textBaseline = 'top';
    ctx.fillText(truncate(node.label, 14), b.left + 10, b.top + 22);

    // Metric line: "rps · ms · err%"
    const rps = Math.round(node.throughputRps);
    const lat = Math.round(node.latencyMs);
    const err = node.errorRate.toFixed(1);
    ctx.font = '400 9px JetBrains Mono';
    ctx.fillStyle = '#8a91a3';
    ctx.fillText(`${rps} rps · ${lat}ms · ${err}%`, b.left + 10, b.top + 38);

    // Load bar at bottom
    const barW = NODE_WIDTH - 20;
    const barH = 3;
    const barX = b.left + 10;
    const barY = b.bottom - 10;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(barX, barY, barW, barH);
    const loadColor = node.loadPct > 90 ? '#ef4444' : node.loadPct > 70 ? '#facc15' : baseColor;
    ctx.fillStyle = loadColor;
    ctx.fillRect(barX, barY, (barW * Math.min(100, node.loadPct)) / 100, barH);

    // Ports
    const showPorts = isHover || isSelected || input.pendingEdge?.fromNodeId === node.id;
    const inP = inputPort(node);
    const outP = outputPort(node);
    const portIsHovered = (port: 'in' | 'out') =>
      input.hover.portNodeId === node.id && input.hover.port === port;
    this.drawPort(inP.x, inP.y, cat === 'client', showPorts, portIsHovered('in'));
    this.drawPort(outP.x, outP.y, true, showPorts, portIsHovered('out'));

    // Replica lag indicator
    if (node.type === 'DBReplica' && (node.config.replicaLagMs ?? 0) > 5) {
      ctx.font = '400 9px JetBrains Mono';
      ctx.fillStyle = '#facc15';
      ctx.textAlign = 'right';
      ctx.fillText(`+${Math.round(node.config.replicaLagMs ?? 0)}ms lag`, b.right - 18, b.top + 8);
    }

    // Queue depth indicator
    if (node.type === 'Queue' && node.queueDepth > 1) {
      ctx.font = '400 9px JetBrains Mono';
      ctx.fillStyle = '#e8a96a';
      ctx.textAlign = 'right';
      ctx.fillText(`Q:${Math.round(node.queueDepth)}`, b.right - 18, b.top + 8);
    }
  }

  private drawPort(x: number, y: number, enabled: boolean, visible: boolean, hovered: boolean): void {
    const ctx = this.ctx;
    if (!visible && !hovered) return;
    ctx.beginPath();
    ctx.arc(x, y, hovered ? 5 : 3.5, 0, Math.PI * 2);
    ctx.fillStyle = hovered ? '#4dd0c8' : enabled ? 'rgba(77,208,200,0.6)' : 'rgba(255,255,255,0.25)';
    ctx.fill();
    ctx.strokeStyle = '#0b0d12';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  private drawMinimap(state: SimState): void {
    const ctx = this.miniCtx;
    const w = this.minimap.width;
    const h = this.minimap.height;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, w, h);

    // Determine bounds
    if (state.topology.nodes.length === 0) {
      ctx.restore();
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of state.topology.nodes) {
      const b = nodeBounds(n);
      minX = Math.min(minX, b.left);
      minY = Math.min(minY, b.top);
      maxX = Math.max(maxX, b.right);
      maxY = Math.max(maxY, b.bottom);
    }
    const pad = 40;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const sx = this.miniWidth / (maxX - minX);
    const sy = this.miniHeight / (maxY - minY);
    const s = Math.min(sx, sy);
    const ox = (this.miniWidth - (maxX - minX) * s) / 2;
    const oy = (this.miniHeight - (maxY - minY) * s) / 2;

    const xform = (wx: number, wy: number) => ({
      x: ox + (wx - minX) * s,
      y: oy + (wy - minY) * s,
    });

    // Edges
    const nodeMap = new Map(state.topology.nodes.map(n => [n.id, n]));
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    for (const e of state.topology.edges) {
      const f = nodeMap.get(e.fromId);
      const t = nodeMap.get(e.toId);
      if (!f || !t) continue;
      const a = xform(f.x, f.y);
      const b = xform(t.x, t.y);
      ctx.strokeStyle = e.partitioned ? '#ef4444' : 'rgba(255,255,255,0.18)';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // Nodes
    for (const n of state.topology.nodes) {
      const p = xform(n.x, n.y);
      const color = n.status === 'down' ? '#ef4444' : nodeColor(n);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Viewport rect
    const vTopLeft = this.screenToWorld(0, 0);
    const vBotRight = this.screenToWorld(this.width, this.height);
    const a = xform(vTopLeft.x, vTopLeft.y);
    const b = xform(vBotRight.x, vBotRight.y);
    ctx.strokeStyle = 'rgba(77,208,200,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);

    ctx.restore();
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

// Helper used externally to render a single packet's screen position (e.g., for tests)
export function packetScreen(_p: Packet): { x: number; y: number } {
  return { x: 0, y: 0 };
}
