# Node types

DistroSim ships eighteen node types, grouped into four categories. Each type has its own per-tick behavior and a small config bag (`NodeConfig`) that you can edit from the right sidebar.

Source of truth: [`src/types.ts`](../src/types.ts) (constants) and [`src/simulation.ts`](../src/simulation.ts) (per-tick math).

## Categories at a glance

| Category | Color     | Members                                                                  |
|----------|-----------|--------------------------------------------------------------------------|
| client   | `#378ADD` | Client                                                                   |
| compute  | `#1D9E75` | LoadBalancer, APIServer, ServiceMesh, RateLimiter, AuthService, WAF      |
| data     | `#BA7517` | DBPrimary, DBReplica, KeyValueStore, ObjectStore, SearchIndex            |
| infra    | `#888780` | Cache, Queue, CDN, MessageBroker, DNS, ConfigStore                       |

Categories control color only; the category does not change behavior.

## Quick reference

| Type           | Glyph    | Default config                               | Behavior                                                  |
|----------------|----------|----------------------------------------------|-----------------------------------------------------------|
| Client         | `CLI`    | `emitRps: 100`                               | Source: emits `emitRps` requests per tick                 |
| LoadBalancer   | `LB`     | `capacityRps: 5000`                          | Forwarder; tiny service latency                           |
| APIServer      | `API`    | `capacityRps: 800`                           | Forwarder; visible service latency under load             |
| DBPrimary      | `DB`     | `capacityRps: 1000`                          | Terminal; latency rises with load                         |
| DBReplica      | `DB·R`   | `capacityRps: 1500, replicaLagMs: 0`         | Terminal; tracks replica lag                              |
| Cache          | `CACHE`  | `hitRate: 0.7, capacityRps: 5000`            | Splits: hits terminate, misses pass through               |
| Queue          | `MQ`     | `drainRate: 500, capacity: 10000`            | FIFO buffer; depth grows when inbound > drain             |
| CDN            | `CDN`    | `hitRate: 0.85, capacityRps: 20000`          | Edge cache; absorbs static traffic                        |
| KeyValueStore  | `KV`     | `hitRate: 0.9, capacityRps: 12000`           | Redis-style; high hit rate, ~0.5ms hit latency            |
| ObjectStore    | `S3`     | `capacityRps: 10000`                         | S3-style blob store; ~25ms base latency                   |
| MessageBroker  | `KAFKA`  | `drainRate: 2000, capacity: 100000`          | Pub/sub broker; deeper buffer than Queue                  |
| SearchIndex    | `SEARCH` | `capacityRps: 600`                           | Elasticsearch-style; ~20ms base latency                   |
| DNS            | `DNS`    | `capacityRps: 50000`                         | Resolver; very low latency, very high capacity            |
| ServiceMesh    | `MESH`   | `capacityRps: 8000`                          | Sidecar/Envoy passthrough; ~1.5ms overhead                |
| RateLimiter    | `RL`     | `capacityRps: 5000, limitRps: 1000`          | Hard rate limit; drops above `limitRps`                   |
| AuthService    | `AUTH`   | `capacityRps: 2000, tokenCacheHitRate: 0.85` | Token validation; cache miss adds 25ms                    |
| WAF            | `WAF`    | `capacityRps: 6000`                          | Inspection layer; ~3ms base latency                       |
| ConfigStore    | `CFG`    | `capacityRps: 2000, hitRate: 0.95`           | etcd/Consul-style; almost everything terminates locally   |

## Detailed behavior — original eight

(See git history for the original write-ups; they're unchanged in this revision.)

## Detailed behavior — new types

### KeyValueStore (`KV`)

Redis/Memcached. Splits like a `Cache` but with higher defaults — 90% hit rate, 12k rps, ~0.5ms hit latency. The natural target for `cache-poisoning`, `cache-eviction`, `cache-oom`, and the entire Cache Layer Chaos family. Misses fall through to whatever you wire downstream (typically a DB).

### ObjectStore (`S3`)

Blob/object store. Terminal node with high capacity (10k rps) and ~25ms base service latency. LSM-style compaction storms (via `lsm-compaction`) tack +60ms onto every request for the duration of the storm.

### MessageBroker (`KAFKA`)

Like `Queue`, but deeper (100k capacity, 2k drain) and with a higher base service latency (~5ms). Use it for fan-out / pub-sub topologies where a `Queue` is too thin.

### SearchIndex (`SEARCH`)

Elasticsearch-style read terminal. Modest capacity (600 rps), high base latency (20ms), capacity-aware service latency. Targetable by data-layer chaos (query plan regression, lock contention, etc.).

### DNS (`DNS`)

Forwarder, very thin. 50k rps, 0.5ms latency. Mostly a topology landmark; the interesting failure mode is `dns-failure` on its outbound edges, which inflates latency by 250ms for 10s.

### ServiceMesh (`MESH`)

Envoy/Linkerd sidecar. Forwarder with ~1.5ms overhead. Like a `LoadBalancer`, it skips outbound edges when the destination is marked `unhealthy` by `health-check-fail`.

### RateLimiter (`RL`)

Two caps: `limitRps` (hard, anything above is dropped as errors) and `capacityRps` (the usual M/M/1-style soft cap). Use it to model token-bucket / leaky-bucket gateways.

### AuthService (`AUTH`)

Token validation. Effective latency is a weighted average:

```
latency = (fast × 1ms + slow × 25ms) / inbound + serviceLatency(...)
```

where `fast = inbound × tokenCacheHitRate` and `slow = inbound × (1 - tokenCacheHitRate)`. Drops `tokenCacheHitRate` to see tail latency explode.

### WAF (`WAF`)

Web Application Firewall. Forwarder with ~3ms base inspection latency. Useful for placing in front of LBs/APIs to model added latency from request inspection.

### ConfigStore (`CFG`)

etcd/Consul-style. Acts like a small `Cache` (95% hit rate, 1.5ms hit latency). Miss traffic forwards downstream, which lets you simulate config-fetch fan-out patterns.

## Capacity and utilization

Most node types use `baseCapacity()`:

| Type                   | Capacity source     |
|------------------------|---------------------|
| Client                 | `emitRps`           |
| Queue, MessageBroker   | `drainRate`         |
| Other                  | `capacityRps`       |

Effective capacity is multiplied by `effects.capacityMul`, which chaos events use to throttle a node (CPU throttle, noisy neighbor, memory leak, etc.). See [chaos.md](chaos.md) for the full list of effects.

## Status transitions

```
healthy  ──(errPct > 5% OR util > 95%)──▶  degraded
healthy  ──(killNode / chaos)────────────▶  down
healthy  ──(unhealthy effect)────────────▶  degraded (LBs route around)
degraded ──(load returns to normal)──────▶  healthy
down     ──(recoverNode)─────────────────▶  healthy
down     ──(permanent flag set)──────────▶  recovery refused
```

Permanent down is set by hardware-failure / dc-failure / disk-failure. Use **Clear effects** in the inspector to wipe the permanent flag and other modifiers.

## Editing nodes

- **Sidebar** — Click a node to open its config panel. Edits write directly to `node.config` and take effect on the next tick.
- **Clear effects** button — Wipes all chaos-applied effects on the selected node.
- **Double-click** — Rename a node in place.
- **Drag** — Move a node on the canvas.
- **Delete / Backspace** — Remove the selected node and its incident edges.

See [controls.md](controls.md) for the full input reference.
