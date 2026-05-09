import { CanvasRenderer, type PendingEdge } from './canvas';
import {
  cascadeFailure,
  exportTopology,
  importTopology,
  injectLatencySpike,
  killNode,
  partitionBetween,
  partitionEdge,
  pushEvent,
  recoverNode,
  tickChaos,
} from './chaos';
import { makeEdge } from './edges';
import {
  ALL_NODE_TYPES,
  makeNode,
  outputPort,
} from './nodes';
import {
  PRESETS,
  type PresetKey,
} from './presets';
import {
  advancePackets,
  createSimState,
  resetSimMetrics,
  runTick,
  type SimState,
} from './simulation';
import {
  drawSparkline,
  formatMetricValue,
  formatRps,
  metricSeverity,
  SPARK_CONFIG,
  type MetricKey,
} from './metrics';
import {
  CATEGORY,
  CATEGORY_COLOR,
  type ChaosMode,
  type NodeType,
  type Selection,
  type SimEdge,
  type SimNode,
} from './types';

const DEBUG = false;

interface HoverState {
  nodeId: string | null;
  edgeId: string | null;
  port: 'in' | 'out' | null;
  portNodeId: string | null;
}

class App {
  state: SimState;
  renderer: CanvasRenderer;
  selection: Selection = { nodeId: null, edgeId: null };
  hover: HoverState = { nodeId: null, edgeId: null, port: null, portNodeId: null };
  pendingEdge: PendingEdge | null = null;
  draggingNode: { nodeId: string; offsetX: number; offsetY: number } | null = null;
  panning: { startX: number; startY: number } | null = null;
  spacePressed = false;
  chaosMode: ChaosMode = null;
  partitionFirstNodeId: string | null = null;
  undoStack: string[] = [];
  tickIntervalId: number | null = null;
  lastFrameTime = 0;
  // DOM refs
  private canvas: HTMLCanvasElement;
  private mainEl: HTMLElement;
  private inspectorEl: HTMLElement;
  private eventLogEl: HTMLElement;
  private nodePickerEl: HTMLElement;
  private nodePickerListEl: HTMLElement;
  private toastEl: HTMLElement;
  private sparkpanelEl: HTMLElement;
  private sparkpanelBodyEl: HTMLElement;
  private sparkCanvases: Map<MetricKey, HTMLCanvasElement> = new Map();

  constructor() {
    this.canvas = byId<HTMLCanvasElement>('canvas');
    this.mainEl = byId<HTMLElement>('canvas').parentElement as HTMLElement;
    this.inspectorEl = byId<HTMLElement>('inspector');
    this.eventLogEl = byId<HTMLElement>('event-log');
    this.nodePickerEl = byId<HTMLElement>('node-picker');
    this.nodePickerListEl = byId<HTMLElement>('node-picker-list');
    this.toastEl = byId<HTMLElement>('toast');
    this.sparkpanelEl = byId<HTMLElement>('sparkpanel');
    this.sparkpanelBodyEl = byId<HTMLElement>('sparkpanel-body');
    const minimap = byId<HTMLCanvasElement>('minimap-canvas');
    this.state = createSimState({ nodes: [], edges: [] });
    this.renderer = new CanvasRenderer(this.canvas, minimap);
    this.bindEvents();
    this.buildNodePicker();
    this.buildPalette();
    this.buildSparkPanel();
    this.loadPreset('three-tier');
    this.startRenderLoop();
    this.scheduleTickLoop();

    // Re-fit once layout has fully settled (custom fonts can shift things).
    const reFit = () => {
      this.renderer.resize();
      if (!this.userMovedView) this.fitView();
    };
    requestAnimationFrame(() => requestAnimationFrame(reFit));
    if ('fonts' in document) {
      (document as Document).fonts.ready.then(reFit).catch(() => undefined);
    }
  }

  private userMovedView = false;

  // ------- Event wiring -------

  private bindEvents(): void {
    const canvas = this.canvas;

    canvas.addEventListener('mousedown', e => this.onMouseDown(e));
    canvas.addEventListener('mousemove', e => this.onMouseMove(e));
    window.addEventListener('mouseup', e => this.onMouseUp(e));
    canvas.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    canvas.addEventListener('dblclick', e => this.onDoubleClick(e));
    canvas.addEventListener('contextmenu', e => e.preventDefault());

    window.addEventListener('keydown', e => this.onKeyDown(e));
    window.addEventListener('keyup', e => this.onKeyUp(e));

    byId<HTMLButtonElement>('sim-toggle').addEventListener('click', () => this.toggleSim());
    const tickRange = byId<HTMLInputElement>('tick-rate');
    const tickVal = byId<HTMLElement>('tick-rate-val');
    tickRange.addEventListener('input', () => {
      this.state.ticksPerSec = parseInt(tickRange.value, 10);
      tickVal.textContent = `${this.state.ticksPerSec}/s`;
      this.scheduleTickLoop();
    });

    byId<HTMLSelectElement>('preset-select').addEventListener('change', e => {
      const key = (e.target as HTMLSelectElement).value as PresetKey | '';
      if (!key) return;
      this.loadPreset(key);
      (e.target as HTMLSelectElement).value = '';
    });

    byId<HTMLButtonElement>('fit-btn').addEventListener('click', () => {
      this.userMovedView = false;
      this.fitView();
    });
    byId<HTMLButtonElement>('export-btn').addEventListener('click', () => this.exportJson());
    const importInput = byId<HTMLInputElement>('import-input');
    byId<HTMLButtonElement>('import-btn').addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', () => {
      const file = importInput.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result ?? '');
        this.importJson(text);
      };
      reader.readAsText(file);
      importInput.value = '';
    });

    document.querySelectorAll<HTMLButtonElement>('.chaos-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.chaos as ChaosMode;
        this.activateChaos(mode);
      });
    });

    byId<HTMLElement>('sparkpanel-header').addEventListener('click', () => {
      this.sparkpanelEl.classList.toggle('collapsed');
      const hint = byId<HTMLElement>('sparkpanel-hint');
      hint.textContent = this.sparkpanelEl.classList.contains('collapsed')
        ? 'click to expand'
        : 'click to collapse';
    });
  }

  private buildNodePicker(): void {
    this.nodePickerListEl.innerHTML = '';
    for (const t of ALL_NODE_TYPES) {
      const item = document.createElement('div');
      item.className = 'node-picker-item';
      item.dataset.type = t;
      const sw = document.createElement('span');
      sw.className = 'node-picker-swatch';
      sw.style.background = CATEGORY_COLOR[CATEGORY[t]];
      const name = document.createElement('span');
      name.textContent = t;
      item.appendChild(sw);
      item.appendChild(name);
      item.addEventListener('click', () => {
        this.closeNodePicker();
        this.placeNodeAtCursor(t);
      });
      this.nodePickerListEl.appendChild(item);
    }
  }

  private buildPalette(): void {
    const body = byId<HTMLElement>('palette-body');
    body.innerHTML = '';
    const groups: Array<{ title: string; types: NodeType[] }> = [
      { title: 'Clients', types: ['Client'] },
      { title: 'Compute', types: ['LoadBalancer', 'APIServer'] },
      { title: 'Data', types: ['DBPrimary', 'DBReplica'] },
      { title: 'Infra', types: ['Cache', 'Queue', 'CDN'] },
    ];
    for (const group of groups) {
      const section = document.createElement('div');
      section.className = 'palette-section';
      const title = document.createElement('div');
      title.className = 'palette-section-title';
      title.textContent = group.title;
      section.appendChild(title);
      for (const type of group.types) {
        section.appendChild(this.makePaletteItem(type));
      }
      body.appendChild(section);
    }

    const header = byId<HTMLElement>('palette-header');
    const palette = byId<HTMLElement>('palette');
    const chevron = byId<HTMLElement>('palette-collapse');
    header.addEventListener('click', () => {
      palette.classList.toggle('collapsed');
      chevron.textContent = palette.classList.contains('collapsed') ? '›' : '‹';
    });

    // Canvas drop targets
    this.canvas.addEventListener('dragover', e => {
      if (!this.dragNodeType) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'copy';
      this.canvas.classList.add('canvas-drop-active');
    });
    this.canvas.addEventListener('dragleave', () => {
      this.canvas.classList.remove('canvas-drop-active');
    });
    this.canvas.addEventListener('drop', e => {
      e.preventDefault();
      this.canvas.classList.remove('canvas-drop-active');
      const type = (e.dataTransfer?.getData('application/x-distrosim-node') ||
        this.dragNodeType) as NodeType | '';
      this.dragNodeType = null;
      if (!type) return;
      const r = this.canvas.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      const w = this.renderer.screenToWorld(sx, sy);
      let { x, y } = w;
      // Nudge if dropped on top of an existing node so they don't stack.
      let attempts = 0;
      while (this.renderer.pickNode(this.state, x, y) && attempts < 12) {
        x += 38;
        y += 24;
        attempts += 1;
      }
      this.snapshot();
      const node = makeNode(type as NodeType, x, y);
      this.state.topology.nodes.push(node);
      this.selection = { nodeId: node.id, edgeId: null };
      this.refreshInspector();
      this.toast(`added ${type}`);
    });
  }

  private dragNodeType: NodeType | null = null;
  private clickPlaceCounter = 0;

  private makePaletteItem(type: NodeType): HTMLElement {
    const item = document.createElement('div');
    item.className = 'palette-item';
    item.draggable = true;
    item.dataset.type = type;
    item.title = `Drag onto canvas to add a ${type}`;

    const sw = document.createElement('span');
    sw.className = 'palette-swatch';
    sw.style.setProperty('--swatch-color', CATEGORY_COLOR[CATEGORY[type]]);
    item.appendChild(sw);

    const name = document.createElement('span');
    name.className = 'palette-name';
    name.textContent = type;
    item.appendChild(name);

    item.addEventListener('dragstart', e => {
      this.dragNodeType = type;
      item.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('application/x-distrosim-node', type);
        e.dataTransfer.setData('text/plain', type);
      }
    });
    item.addEventListener('dragend', () => {
      this.dragNodeType = null;
      item.classList.remove('dragging');
      this.canvas.classList.remove('canvas-drop-active');
    });

    // Click as fallback: drop near canvas center, staggered so consecutive
    // clicks don't pile up on top of each other.
    item.addEventListener('click', () => {
      const i = this.clickPlaceCounter++ % 8;
      const offsetX = (i % 4) * 36 - 54;
      const offsetY = Math.floor(i / 4) * 36 - 18;
      const sx = this.renderer.width / 2 + offsetX;
      const sy = this.renderer.height / 2 + offsetY;
      const w = this.renderer.screenToWorld(sx, sy);
      this.snapshot();
      const node = makeNode(type, w.x, w.y);
      this.state.topology.nodes.push(node);
      this.selection = { nodeId: node.id, edgeId: null };
      this.refreshInspector();
      this.toast(`added ${type}`);
    });

    return item;
  }

  private buildSparkPanel(): void {
    this.sparkpanelBodyEl.innerHTML = '';
    for (const cfg of SPARK_CONFIG) {
      const card = document.createElement('div');
      card.className = 'sparkcard';
      const head = document.createElement('div');
      head.className = 'sparkcard-header';
      const label = document.createElement('span');
      label.className = 'sparkcard-label';
      label.textContent = cfg.label;
      const value = document.createElement('span');
      value.className = 'sparkcard-value';
      value.id = `spark-val-${cfg.key}`;
      value.textContent = '—';
      head.appendChild(label);
      head.appendChild(value);
      const canvas = document.createElement('canvas');
      canvas.className = 'sparkcard-canvas';
      card.appendChild(head);
      card.appendChild(canvas);
      this.sparkpanelBodyEl.appendChild(card);
      this.sparkCanvases.set(cfg.key, canvas);
    }
  }

  // ------- Mouse handling -------

  private getCursor(e: MouseEvent): { sx: number; sy: number; wx: number; wy: number } {
    const r = this.canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const w = this.renderer.screenToWorld(sx, sy);
    return { sx, sy, wx: w.x, wy: w.y };
  }

  private onMouseDown(e: MouseEvent): void {
    const cursor = this.getCursor(e);

    // Pan with space+drag or middle click
    if ((this.spacePressed && e.button === 0) || e.button === 1) {
      this.panning = { startX: e.clientX, startY: e.clientY };
      this.canvas.classList.add('panning');
      e.preventDefault();
      return;
    }

    // Right click: clear selection / cancel chaos
    if (e.button === 2) {
      this.cancelInteractions();
      return;
    }

    // Chaos modes intercept clicks
    if (this.chaosMode === 'kill') {
      const node = this.renderer.pickNode(this.state, cursor.wx, cursor.wy);
      if (node) {
        this.snapshot();
        killNode(this.state, node.id);
        this.chaosMode = null;
        this.toast(`killed ${node.label}`);
        this.refreshInspector();
      } else {
        this.cancelChaos();
      }
      return;
    }
    if (this.chaosMode === 'partition') {
      const node = this.renderer.pickNode(this.state, cursor.wx, cursor.wy);
      if (node) {
        if (!this.partitionFirstNodeId) {
          this.partitionFirstNodeId = node.id;
          this.toast(`partition: select target for ${node.label}`);
          return;
        }
        if (this.partitionFirstNodeId === node.id) {
          this.toast('pick a different node');
          return;
        }
        this.snapshot();
        const ok = partitionBetween(this.state, this.partitionFirstNodeId, node.id);
        if (!ok) this.toast('no edge between those nodes');
        else this.toast('partition injected');
        this.partitionFirstNodeId = null;
        this.chaosMode = null;
      } else {
        this.cancelChaos();
      }
      return;
    }
    if (this.chaosMode === 'latency') {
      const edge = this.renderer.pickEdge(this.state, cursor.wx, cursor.wy);
      if (edge) {
        this.snapshot();
        injectLatencySpike(this.state, edge.id);
        this.toast('latency spike for 10s');
        this.chaosMode = null;
      } else {
        this.toast('click an edge to inject latency');
      }
      return;
    }

    // Prefer node body. Only treat as a port click if the cursor is right
    // on top of the port marker (small radius). Otherwise drag the node.
    const node = this.renderer.pickNode(this.state, cursor.wx, cursor.wy);
    if (node) {
      const op = outputPort(node);
      const dop = Math.hypot(cursor.wx - op.x, cursor.wy - op.y);
      if (dop <= 7) {
        this.pendingEdge = {
          fromNodeId: node.id,
          cursorWorldX: cursor.wx,
          cursorWorldY: cursor.wy,
        };
        return;
      }
      this.snapshot();
      this.draggingNode = {
        nodeId: node.id,
        offsetX: node.x - cursor.wx,
        offsetY: node.y - cursor.wy,
      };
      this.selection = { nodeId: node.id, edgeId: null };
      this.refreshInspector();
      return;
    }

    // Empty-space port click is also valid: lets you start a drag from a
    // hovered output port that's slightly outside the node body.
    const portHit = this.renderer.pickPort(this.state, cursor.wx, cursor.wy);
    if (portHit && portHit.port === 'out') {
      this.pendingEdge = {
        fromNodeId: portHit.node.id,
        cursorWorldX: cursor.wx,
        cursorWorldY: cursor.wy,
      };
      return;
    }

    // Edge click
    const edge = this.renderer.pickEdge(this.state, cursor.wx, cursor.wy);
    if (edge) {
      this.selection = { nodeId: null, edgeId: edge.id };
      this.refreshInspector();
      return;
    }

    // Empty canvas click → clear selection
    this.selection = { nodeId: null, edgeId: null };
    this.refreshInspector();
  }

  private onMouseMove(e: MouseEvent): void {
    const cursor = this.getCursor(e);

    if (this.panning) {
      const dx = e.clientX - this.panning.startX;
      const dy = e.clientY - this.panning.startY;
      this.renderer.panBy(dx, dy);
      this.panning.startX = e.clientX;
      this.panning.startY = e.clientY;
      this.userMovedView = true;
      return;
    }

    if (this.draggingNode) {
      const node = this.state.topology.nodes.find(n => n.id === this.draggingNode!.nodeId);
      if (node) {
        node.x = cursor.wx + this.draggingNode.offsetX;
        node.y = cursor.wy + this.draggingNode.offsetY;
      }
      return;
    }

    if (this.pendingEdge) {
      this.pendingEdge.cursorWorldX = cursor.wx;
      this.pendingEdge.cursorWorldY = cursor.wy;
      // Highlight a target input port if hovering
      const portHit = this.renderer.pickPort(this.state, cursor.wx, cursor.wy);
      this.hover = {
        nodeId: portHit?.node.id ?? null,
        edgeId: null,
        port: portHit?.port ?? null,
        portNodeId: portHit?.node.id ?? null,
      };
      return;
    }

    // Hover detection
    const portHit = this.renderer.pickPort(this.state, cursor.wx, cursor.wy);
    if (portHit) {
      this.hover = {
        nodeId: portHit.node.id,
        edgeId: null,
        port: portHit.port,
        portNodeId: portHit.node.id,
      };
      this.canvas.style.cursor = 'crosshair';
      return;
    }
    const node = this.renderer.pickNode(this.state, cursor.wx, cursor.wy);
    if (node) {
      this.hover = { nodeId: node.id, edgeId: null, port: null, portNodeId: null };
      this.canvas.style.cursor = 'move';
      return;
    }
    const edge = this.renderer.pickEdge(this.state, cursor.wx, cursor.wy);
    if (edge) {
      this.hover = { nodeId: null, edgeId: edge.id, port: null, portNodeId: null };
      this.canvas.style.cursor = 'pointer';
      return;
    }
    this.hover = { nodeId: null, edgeId: null, port: null, portNodeId: null };
    this.canvas.style.cursor = this.spacePressed ? 'grab' : 'default';
  }

  private onMouseUp(e: MouseEvent): void {
    if (this.panning) {
      this.panning = null;
      this.canvas.classList.remove('panning');
    }
    if (this.draggingNode) {
      this.draggingNode = null;
    }
    if (this.pendingEdge) {
      const cursor = this.getCursor(e);
      const portHit = this.renderer.pickPort(this.state, cursor.wx, cursor.wy);
      if (portHit && portHit.port === 'in' && portHit.node.id !== this.pendingEdge.fromNodeId) {
        const from = this.state.topology.nodes.find(n => n.id === this.pendingEdge!.fromNodeId);
        if (from) {
          // Avoid duplicate edges
          const exists = this.state.topology.edges.some(
            edge => edge.fromId === from.id && edge.toId === portHit.node.id
          );
          if (!exists) {
            this.snapshot();
            const e = makeEdge(from, portHit.node);
            this.state.topology.edges.push(e);
            this.selection = { nodeId: null, edgeId: e.id };
            this.refreshInspector();
          } else {
            this.toast('edge already exists');
          }
        }
      }
      this.pendingEdge = null;
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const cursor = this.getCursor(e);
    const factor = Math.exp(-e.deltaY * 0.0015);
    this.renderer.zoomAt(cursor.sx, cursor.sy, factor);
    this.userMovedView = true;
  }

  private onDoubleClick(e: MouseEvent): void {
    const cursor = this.getCursor(e);
    const node = this.renderer.pickNode(this.state, cursor.wx, cursor.wy);
    if (node) {
      this.openLabelEditor(node);
    }
  }

  private openLabelEditor(node: SimNode): void {
    const screen = this.renderer.worldToScreen(node.x, node.y);
    const input = document.createElement('input');
    input.className = 'label-input';
    input.value = node.label;
    const mainRect = this.mainEl.getBoundingClientRect();
    void mainRect;
    input.style.left = `${screen.x - 50}px`;
    input.style.top = `${screen.y - 8}px`;
    input.style.width = '100px';
    this.mainEl.appendChild(input);
    input.focus();
    input.select();
    const commit = () => {
      const v = input.value.trim();
      if (v) {
        this.snapshot();
        node.label = v;
      }
      input.remove();
      this.refreshInspector();
    };
    const cancel = () => input.remove();
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        commit();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        cancel();
      }
    });
  }

  private onKeyDown(e: KeyboardEvent): void {
    // Don't intercept keys while typing in form fields
    const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

    if (e.code === 'Space') {
      this.spacePressed = true;
      this.canvas.classList.add('pannable');
      e.preventDefault();
      return;
    }
    if (e.key === 'n' || e.key === 'N') {
      this.openNodePickerAtCursor();
      e.preventDefault();
      return;
    }
    if (e.key === 's' || e.key === 'S') {
      this.toggleSim();
      e.preventDefault();
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      this.deleteSelection();
      e.preventDefault();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
      this.undo();
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      this.cancelInteractions();
      this.closeNodePicker();
      return;
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (e.code === 'Space') {
      this.spacePressed = false;
      this.canvas.classList.remove('pannable');
    }
  }

  // ------- Actions -------

  private cursorScreen = { sx: 0, sy: 0 };

  private openNodePickerAtCursor(): void {
    // Place picker near current mouse position; fall back to canvas center.
    const x = this.cursorScreen.sx || this.renderer.width / 2;
    const y = this.cursorScreen.sy || this.renderer.height / 2;
    const mainRect = this.mainEl.getBoundingClientRect();
    void mainRect;
    this.nodePickerEl.style.left = `${x}px`;
    this.nodePickerEl.style.top = `${y}px`;
    this.nodePickerEl.classList.add('open');
    const handler = (ev: MouseEvent) => {
      if (!this.nodePickerEl.contains(ev.target as Node)) {
        this.closeNodePicker();
        document.removeEventListener('mousedown', handler, true);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', handler, true), 0);
  }

  private closeNodePicker(): void {
    this.nodePickerEl.classList.remove('open');
  }

  private placeNodeAtCursor(type: NodeType): void {
    const sx = this.cursorScreen.sx || this.renderer.width / 2;
    const sy = this.cursorScreen.sy || this.renderer.height / 2;
    const w = this.renderer.screenToWorld(sx, sy);
    this.snapshot();
    const node = makeNode(type, w.x, w.y);
    this.state.topology.nodes.push(node);
    this.selection = { nodeId: node.id, edgeId: null };
    this.refreshInspector();
    this.toast(`added ${type}`);
  }

  private deleteSelection(): void {
    if (this.selection.nodeId) {
      this.snapshot();
      const id = this.selection.nodeId;
      this.state.topology.nodes = this.state.topology.nodes.filter(n => n.id !== id);
      this.state.topology.edges = this.state.topology.edges.filter(
        e => e.fromId !== id && e.toId !== id
      );
      this.selection = { nodeId: null, edgeId: null };
      this.refreshInspector();
      this.toast('deleted node');
    } else if (this.selection.edgeId) {
      this.snapshot();
      const id = this.selection.edgeId;
      this.state.topology.edges = this.state.topology.edges.filter(e => e.id !== id);
      this.selection = { nodeId: null, edgeId: null };
      this.refreshInspector();
      this.toast('deleted edge');
    }
  }

  private toggleSim(): void {
    this.state.running = !this.state.running;
    if (this.state.running) {
      pushEvent(this.state, 'info', 'simulation started');
    } else {
      pushEvent(this.state, 'info', 'simulation paused');
    }
    this.updateSimBadge();
  }

  private updateSimBadge(): void {
    const badge = byId<HTMLElement>('sim-badge');
    const label = byId<HTMLElement>('sim-state-label');
    const btn = byId<HTMLButtonElement>('sim-toggle');
    if (this.state.running) {
      badge.classList.add('running');
      label.textContent = 'running';
      btn.textContent = 'Pause sim';
    } else {
      badge.classList.remove('running');
      label.textContent = 'paused';
      btn.textContent = 'Start sim';
    }
  }

  private activateChaos(mode: ChaosMode): void {
    if (mode === 'cascade') {
      this.snapshot();
      cascadeFailure(this.state);
      return;
    }
    this.chaosMode = mode;
    this.partitionFirstNodeId = null;
    if (mode === 'kill') this.toast('click a node to kill');
    if (mode === 'partition') this.toast('click two nodes that share an edge');
    if (mode === 'latency') this.toast('click an edge for +500ms (10s)');
  }

  private cancelChaos(): void {
    this.chaosMode = null;
    this.partitionFirstNodeId = null;
  }

  private cancelInteractions(): void {
    this.cancelChaos();
    this.pendingEdge = null;
    this.selection = { nodeId: null, edgeId: null };
    this.refreshInspector();
  }

  private loadPreset(key: PresetKey): void {
    this.snapshot();
    const preset = PRESETS[key];
    const t = preset.build();
    this.state.topology = t;
    resetSimMetrics(this.state);
    this.selection = { nodeId: null, edgeId: null };
    this.refreshInspector();
    this.userMovedView = false;
    this.fitView();
    pushEvent(this.state, 'info', `loaded preset: ${preset.name}`);
  }

  private fitView(): void {
    const nodes = this.state.topology.nodes;
    if (nodes.length === 0) {
      this.renderer.viewport = { panX: 0, panY: 0, zoom: 1 };
      return;
    }
    // If the canvas hasn't been laid out yet, bail without touching the
    // viewport — a later reFit (rAF/fonts.ready) will retry with valid dims.
    if (this.renderer.width <= 0 || this.renderer.height <= 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x);
      maxY = Math.max(maxY, n.y);
    }
    const pad = 140;
    const w = Math.max(1, maxX - minX + pad * 2);
    const h = Math.max(1, maxY - minY + pad * 2);
    // Clamp zoom away from zero so the world transform never collapses.
    const fit = Math.min(this.renderer.width / w, this.renderer.height / h);
    const z = Math.max(0.25, Math.min(1.2, fit));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    this.renderer.viewport.zoom = z;
    this.renderer.viewport.panX = this.renderer.width / 2 - cx * z;
    this.renderer.viewport.panY = this.renderer.height / 2 - cy * z;
  }

  private exportJson(): void {
    const json = exportTopology(this.state.topology);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `distrosim-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    this.toast('exported topology');
  }

  private importJson(text: string): void {
    const imported = importTopology(text);
    if (!imported) {
      this.toast('invalid topology JSON');
      return;
    }
    this.snapshot();
    const nodes: SimNode[] = imported.nodes.map(n => {
      const built = makeNode(n.type, n.x, n.y, n.label);
      built.id = n.id;
      built.config = { ...built.config, ...n.config };
      return built;
    });
    const edges: SimEdge[] = imported.edges.map(e => {
      const from = nodes.find(n => n.id === e.fromId);
      const to = nodes.find(n => n.id === e.toId);
      if (!from || !to) return null;
      const built = makeEdge(from, to);
      built.id = e.id;
      built.baseLatencyMs = e.baseLatencyMs;
      built.throughputRps = e.throughputRps;
      return built;
    }).filter((x): x is SimEdge => x !== null);
    this.state.topology = { nodes, edges };
    resetSimMetrics(this.state);
    this.selection = { nodeId: null, edgeId: null };
    this.fitView();
    this.refreshInspector();
    this.toast('imported topology');
  }

  // ------- Inspector -------

  private refreshInspector(): void {
    const el = this.inspectorEl;
    el.innerHTML = '';
    if (this.selection.nodeId) {
      const node = this.state.topology.nodes.find(n => n.id === this.selection.nodeId);
      if (node) this.renderNodeInspector(el, node);
    } else if (this.selection.edgeId) {
      const edge = this.state.topology.edges.find(e => e.id === this.selection.edgeId);
      if (edge) this.renderEdgeInspector(el, edge);
    } else {
      const empty = document.createElement('div');
      empty.className = 'inspector-empty';
      empty.innerHTML = `Select a node or edge.<br/>Drag from the <b style="color:var(--text)">palette</b> or press <b style="color:var(--text)">N</b> to add a node.`;
      el.appendChild(empty);
    }
  }

  private renderNodeInspector(el: HTMLElement, node: SimNode): void {
    const target = document.createElement('div');
    target.className = 'inspector-target';
    const icon = document.createElement('div');
    icon.className = 'inspector-target-icon';
    icon.style.color = CATEGORY_COLOR[CATEGORY[node.type]];
    icon.textContent = node.type[0]!;
    const meta = document.createElement('div');
    meta.className = 'inspector-target-meta';
    const name = document.createElement('div');
    name.className = 'inspector-target-name';
    name.textContent = node.label;
    const type = document.createElement('div');
    type.className = 'inspector-target-type';
    type.textContent = node.type;
    meta.appendChild(name);
    meta.appendChild(type);
    target.appendChild(icon);
    target.appendChild(meta);
    el.appendChild(target);

    const grid = document.createElement('div');
    grid.className = 'stat-grid';
    grid.appendChild(stat('Status', node.status));
    grid.appendChild(stat('Load', `${node.loadPct.toFixed(0)}%`));
    grid.appendChild(stat('Latency', `${node.latencyMs.toFixed(0)}ms`));
    grid.appendChild(stat('Errors', `${node.errorRate.toFixed(2)}%`));
    grid.appendChild(stat('Throughput', `${formatRps(node.throughputRps)}`));
    if (node.type === 'Queue') {
      grid.appendChild(stat('Queue', `${Math.round(node.queueDepth)}`));
    }
    if (node.type === 'DBReplica') {
      grid.appendChild(stat('Replica lag', `${Math.round(node.config.replicaLagMs ?? 0)}ms`));
    }
    el.appendChild(grid);

    // Config controls
    const cfg = document.createElement('div');
    const sub = document.createElement('div');
    sub.className = 'sidebar-subtitle';
    sub.textContent = 'Configuration';
    cfg.appendChild(sub);
    if (node.type === 'Client') {
      cfg.appendChild(numField('Emit RPS', node.config.emitRps ?? 100, 1, 10000, v => {
        node.config.emitRps = v;
      }));
    }
    if (node.type === 'Cache' || node.type === 'CDN') {
      cfg.appendChild(rangeField('Hit rate', node.config.hitRate ?? 0.7, 0, 1, 0.01, v => {
        node.config.hitRate = v;
      }, v => `${Math.round(v * 100)}%`));
      cfg.appendChild(numField('Capacity rps', node.config.capacityRps ?? 5000, 1, 200000, v => {
        node.config.capacityRps = v;
      }));
    }
    if (
      node.type === 'APIServer' ||
      node.type === 'LoadBalancer' ||
      node.type === 'DBPrimary' ||
      node.type === 'DBReplica'
    ) {
      cfg.appendChild(numField('Capacity rps', node.config.capacityRps ?? 1000, 1, 100000, v => {
        node.config.capacityRps = v;
      }));
    }
    if (node.type === 'Queue') {
      cfg.appendChild(numField('Drain rate', node.config.drainRate ?? 500, 1, 100000, v => {
        node.config.drainRate = v;
      }));
      cfg.appendChild(numField('Capacity', node.config.capacity ?? 10000, 1, 1000000, v => {
        node.config.capacity = v;
      }));
    }
    el.appendChild(cfg);

    // Actions
    const row = document.createElement('div');
    row.className = 'row';
    row.style.marginTop = '10px';
    if (node.status === 'down') {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = 'Recover';
      btn.addEventListener('click', () => {
        recoverNode(this.state, node.id);
        this.refreshInspector();
      });
      row.appendChild(btn);
    } else {
      const btn = document.createElement('button');
      btn.className = 'btn danger';
      btn.textContent = 'Kill';
      btn.addEventListener('click', () => {
        killNode(this.state, node.id);
        this.refreshInspector();
      });
      row.appendChild(btn);
    }
    const del = document.createElement('button');
    del.className = 'btn';
    del.textContent = 'Delete';
    del.addEventListener('click', () => this.deleteSelection());
    row.appendChild(del);
    el.appendChild(row);
  }

  private renderEdgeInspector(el: HTMLElement, edge: SimEdge): void {
    const from = this.state.topology.nodes.find(n => n.id === edge.fromId);
    const to = this.state.topology.nodes.find(n => n.id === edge.toId);

    const target = document.createElement('div');
    target.className = 'inspector-target';
    const icon = document.createElement('div');
    icon.className = 'inspector-target-icon';
    icon.textContent = '→';
    icon.style.color = '#4dd0c8';
    const meta = document.createElement('div');
    meta.className = 'inspector-target-meta';
    const name = document.createElement('div');
    name.className = 'inspector-target-name';
    name.textContent = `${from?.label ?? '?'} → ${to?.label ?? '?'}`;
    const type = document.createElement('div');
    type.className = 'inspector-target-type';
    type.textContent = 'Connection';
    meta.appendChild(name);
    meta.appendChild(type);
    target.appendChild(icon);
    target.appendChild(meta);
    el.appendChild(target);

    const grid = document.createElement('div');
    grid.className = 'stat-grid';
    grid.appendChild(stat('Live rps', `${Math.round(edge.measuredRps)}`));
    grid.appendChild(stat('Base latency', `${edge.baseLatencyMs}ms`));
    grid.appendChild(stat('Status', edge.partitioned ? 'partitioned' : 'live'));
    const boosted = this.state.tick < edge.latencyBoostUntilTick;
    grid.appendChild(stat('Boost', boosted ? `+${edge.latencyBoostMs}ms` : '—'));
    el.appendChild(grid);

    const cfg = document.createElement('div');
    const sub = document.createElement('div');
    sub.className = 'sidebar-subtitle';
    sub.textContent = 'Configuration';
    cfg.appendChild(sub);
    cfg.appendChild(numField('Base latency (ms)', edge.baseLatencyMs, 0, 5000, v => {
      edge.baseLatencyMs = v;
    }));
    cfg.appendChild(numField('Throughput cap (rps)', edge.throughputRps, 1, 1000000, v => {
      edge.throughputRps = v;
    }));
    el.appendChild(cfg);

    const row = document.createElement('div');
    row.className = 'row';
    row.style.marginTop = '10px';
    const partBtn = document.createElement('button');
    partBtn.className = 'btn danger';
    partBtn.textContent = edge.partitioned ? 'Heal' : 'Partition';
    partBtn.addEventListener('click', () => {
      partitionEdge(this.state, edge.id);
      this.refreshInspector();
    });
    row.appendChild(partBtn);
    const latBtn = document.createElement('button');
    latBtn.className = 'btn';
    latBtn.textContent = '+500ms 10s';
    latBtn.addEventListener('click', () => {
      injectLatencySpike(this.state, edge.id);
      this.refreshInspector();
    });
    row.appendChild(latBtn);
    const del = document.createElement('button');
    del.className = 'btn';
    del.textContent = 'Delete';
    del.addEventListener('click', () => this.deleteSelection());
    row.appendChild(del);
    el.appendChild(row);
  }

  // ------- Top metrics -------

  private updateTopMetrics(): void {
    const m = this.state.metrics;
    setMetric('m-availability', m.availabilityPct, 'availabilityPct');
    setMetric('m-p99', m.p99LatencyMs, 'p99LatencyMs');
    setMetric('m-throughput', m.throughputRps, 'throughputRps');
    setMetric('m-errors', m.errorRatePct, 'errorRatePct');
    const incidentsEl = byId<HTMLElement>('m-incidents');
    incidentsEl.textContent = `${m.activeIncidents}`;
    incidentsEl.classList.toggle('bad', m.activeIncidents > 2);
    incidentsEl.classList.toggle('warn', m.activeIncidents > 0 && m.activeIncidents <= 2);
  }

  private updateEventLog(): void {
    const el = this.eventLogEl;
    if (this.state.events.length === 0) {
      el.innerHTML = '<div class="event-empty">No events yet.</div>';
      return;
    }
    el.innerHTML = '';
    for (const ev of this.state.events.slice(0, 60)) {
      const row = document.createElement('div');
      row.className = `event ${ev.level}`;
      const time = document.createElement('span');
      time.className = 'event-time';
      time.textContent = formatTime(ev.realTime);
      const msg = document.createElement('span');
      msg.className = 'event-msg';
      msg.textContent = ev.msg;
      row.appendChild(time);
      row.appendChild(msg);
      el.appendChild(row);
    }
  }

  private updateSparklines(): void {
    for (const cfg of SPARK_CONFIG) {
      const canvas = this.sparkCanvases.get(cfg.key);
      if (!canvas) continue;
      drawSparkline(canvas, this.state, cfg);
      const valEl = document.getElementById(`spark-val-${cfg.key}`);
      if (valEl) {
        valEl.textContent = formatMetricValue(cfg.key, this.state.metrics[cfg.key]);
        valEl.style.color = severityToColor(metricSeverity(cfg.key, this.state.metrics[cfg.key]));
      }
    }
  }

  // ------- Loops -------

  private startRenderLoop(): void {
    const tick = (now: number) => {
      const dt = this.lastFrameTime ? now - this.lastFrameTime : 16;
      this.lastFrameTime = now;
      if (this.state.running) {
        advancePackets(this.state, dt);
      }
      this.renderer.render({
        state: this.state,
        selection: this.selection,
        hover: this.hover,
        pendingEdge: this.pendingEdge,
        panActive: !!this.panning,
        spacePressed: this.spacePressed,
        chaosMode: this.chaosMode,
        partitionFirstNodeId: this.partitionFirstNodeId,
      });
      this.updateTopMetrics();
      this.updateEventLog();
      this.updateSparklines();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    // Track cursor for picker placement
    window.addEventListener('mousemove', e => {
      const r = this.canvas.getBoundingClientRect();
      this.cursorScreen = { sx: e.clientX - r.left, sy: e.clientY - r.top };
    });
  }

  private scheduleTickLoop(): void {
    if (this.tickIntervalId !== null) {
      clearInterval(this.tickIntervalId);
    }
    const interval = Math.max(50, 1000 / this.state.ticksPerSec);
    this.tickIntervalId = window.setInterval(() => {
      if (!this.state.running) return;
      runTick(this.state);
      tickChaos(this.state);
    }, interval);
  }

  // ------- Undo -------

  private snapshot(): void {
    const snap = exportTopology(this.state.topology);
    this.undoStack.push(snap);
    if (this.undoStack.length > 30) this.undoStack.shift();
  }

  private undo(): void {
    const last = this.undoStack.pop();
    if (!last) {
      this.toast('nothing to undo');
      return;
    }
    this.importJson(last);
    this.toast('undone');
  }

  // ------- Toast -------

  private toastTimer: number | null = null;
  private toast(msg: string): void {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.classList.remove('show');
    }, 1800);
  }
}

// ------- DOM helpers -------

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id) as T | null;
  if (!el) throw new Error(`element not found: ${id}`);
  return el;
}

function stat(label: string, value: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'stat';
  const l = document.createElement('div');
  l.className = 'stat-label';
  l.textContent = label;
  const v = document.createElement('div');
  v.className = 'stat-value';
  v.textContent = value;
  el.appendChild(l);
  el.appendChild(v);
  return el;
}

function numField(
  label: string,
  initial: number,
  min: number,
  max: number,
  onChange: (v: number) => void
): HTMLElement {
  const f = document.createElement('div');
  f.className = 'field';
  const l = document.createElement('span');
  l.textContent = label;
  const i = document.createElement('input');
  i.type = 'number';
  i.value = String(initial);
  i.min = String(min);
  i.max = String(max);
  i.addEventListener('input', () => {
    const v = parseFloat(i.value);
    if (!isNaN(v)) onChange(Math.max(min, Math.min(max, v)));
  });
  f.appendChild(l);
  f.appendChild(i);
  return f;
}

function rangeField(
  label: string,
  initial: number,
  min: number,
  max: number,
  step: number,
  onChange: (v: number) => void,
  display: (v: number) => string
): HTMLElement {
  const f = document.createElement('div');
  f.className = 'field';
  const l = document.createElement('span');
  l.textContent = label;
  const r = document.createElement('input');
  r.type = 'range';
  r.value = String(initial);
  r.min = String(min);
  r.max = String(max);
  r.step = String(step);
  const v = document.createElement('span');
  v.className = 'field-value';
  v.textContent = display(initial);
  r.addEventListener('input', () => {
    const num = parseFloat(r.value);
    onChange(num);
    v.textContent = display(num);
  });
  f.appendChild(l);
  f.appendChild(r);
  f.appendChild(v);
  return f;
}

function setMetric(id: string, value: number, key: MetricKey): void {
  const el = byId<HTMLElement>(id);
  el.textContent = formatMetricValue(key, value);
  el.classList.remove('good', 'warn', 'bad');
  el.classList.add(metricSeverity(key, value));
}

function severityToColor(s: 'good' | 'warn' | 'bad'): string {
  if (s === 'good') return '#4ade80';
  if (s === 'warn') return '#facc15';
  return '#ef4444';
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

if (DEBUG) console.log('DistroSim booting');

new App();
