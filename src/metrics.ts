import type { SimState } from './simulation';
import type { GlobalMetrics } from './types';

export type MetricKey = keyof Pick<
  GlobalMetrics,
  'availabilityPct' | 'p99LatencyMs' | 'throughputRps' | 'errorRatePct'
>;

interface SparkConfig {
  key: MetricKey;
  label: string;
  unit: string;
  color: string;
  // For y-axis scaling: 'auto' or a fixed max.
  fixedMax?: number;
  // 'high-good' means high values are healthy; 'low-good' is the opposite.
  direction: 'high-good' | 'low-good';
}

export const SPARK_CONFIG: SparkConfig[] = [
  { key: 'availabilityPct', label: 'Availability', unit: '%', color: '#4ade80', fixedMax: 100, direction: 'high-good' },
  { key: 'p99LatencyMs', label: 'p99 Latency', unit: 'ms', color: '#facc15', direction: 'low-good' },
  { key: 'throughputRps', label: 'Throughput', unit: 'rps', color: '#4dd0c8', direction: 'high-good' },
  { key: 'errorRatePct', label: 'Error rate', unit: '%', color: '#ef4444', direction: 'low-good' },
];

export function drawSparkline(
  canvas: HTMLCanvasElement,
  state: SimState,
  cfg: SparkConfig
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  if (canvas.width !== Math.floor(r.width * dpr)) {
    canvas.width = Math.floor(r.width * dpr);
    canvas.height = Math.floor(r.height * dpr);
  }
  const w = r.width;
  const h = r.height;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const samples = state.history;
  if (samples.length < 2) {
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
    return;
  }

  const now = Date.now();
  const horizon = 60_000;
  const t0 = now - horizon;
  const values = samples.map(s => s.m[cfg.key]);
  let vMax = cfg.fixedMax ?? Math.max(1, ...values, 1);
  let vMin = 0;
  if (!cfg.fixedMax) {
    vMax = vMax * 1.15;
  }

  // Background grid
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < 4; i++) {
    const y = (h / 4) * i;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();

  const xFor = (t: number) => ((t - t0) / horizon) * w;
  const yFor = (v: number) => h - ((v - vMin) / (vMax - vMin || 1)) * h;

  // Filled area
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, hexWithAlpha(cfg.color, 0.35));
  grad.addColorStop(1, hexWithAlpha(cfg.color, 0));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(xFor(samples[0]!.t), h);
  for (const s of samples) {
    ctx.lineTo(xFor(s.t), yFor(s.m[cfg.key]));
  }
  ctx.lineTo(xFor(samples[samples.length - 1]!.t), h);
  ctx.closePath();
  ctx.fill();

  // Line
  ctx.strokeStyle = cfg.color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const x = xFor(s.t);
    const y = yFor(s.m[cfg.key]);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Latest dot
  const last = samples[samples.length - 1]!;
  const lx = xFor(last.t);
  const ly = yFor(last.m[cfg.key]);
  ctx.fillStyle = cfg.color;
  ctx.beginPath();
  ctx.arc(lx, ly, 2.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

export function formatMetricValue(key: MetricKey, value: number): string {
  switch (key) {
    case 'availabilityPct':
      return `${value.toFixed(2)}%`;
    case 'p99LatencyMs':
      return value > 0 ? `${value.toFixed(0)} ms` : '— ms';
    case 'throughputRps':
      return `${formatRps(value)}`;
    case 'errorRatePct':
      return `${value.toFixed(2)}%`;
    default:
      return value.toString();
  }
}

export function formatRps(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k req/s`;
  return `${Math.round(v)} req/s`;
}

function hexWithAlpha(hex: string, alpha: number): string {
  // Accept #rrggbb
  if (hex.startsWith('#') && hex.length === 7) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return hex;
}

export function metricSeverity(key: MetricKey, value: number): 'good' | 'warn' | 'bad' {
  switch (key) {
    case 'availabilityPct':
      if (value >= 99.5) return 'good';
      if (value >= 95) return 'warn';
      return 'bad';
    case 'errorRatePct':
      if (value < 0.5) return 'good';
      if (value < 5) return 'warn';
      return 'bad';
    case 'p99LatencyMs':
      if (value <= 100) return 'good';
      if (value <= 500) return 'warn';
      return 'bad';
    case 'throughputRps':
      return 'good';
  }
}
