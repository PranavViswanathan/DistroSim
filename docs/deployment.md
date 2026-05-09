# Deployment

DistroSim has zero runtime state and zero database. Production is just a static bundle (`dist/`) served by an Express process. Anywhere you can run `node server.cjs` will do.

## Build pipeline

```
npm run build
  ├── vite build                              # bundles src/ → dist/
  └── tsc -p tsconfig.server.json             # compiles server.cts → server.cjs
```

Output:

- `dist/` — the static client (HTML, JS, assets)
- `server.cjs` — the Express server (CommonJS, runs on Node 20+)

Both are needed at runtime. `npm start` runs `node server.cjs`, which serves `dist/` and a `/healthz` endpoint.

## Local production check

```bash
npm install
npm run build
PORT=3000 npm start          # http://localhost:3000
```

Or with the Makefile:

```bash
make start                   # build then serve in foreground
make serve-bg                # serve in background; pid in .pids/serve.pid
make logs                    # tail the background server
make stop                    # stop the background server
```

See `make help` for the full target list.

## Docker

The included [`Dockerfile`](../Dockerfile) is a multi-stage Node 20 Alpine build:

```dockerfile
FROM node:20-alpine AS build
# install all deps, copy source, npm run build

FROM node:20-alpine
# install production deps only, copy dist/ and server.cjs
EXPOSE 3000
CMD ["node", "server.cjs"]
```

Build and run locally:

```bash
docker build -t distrosim .
docker run -p 3000:3000 distrosim
```

Or via Make:

```bash
make docker-build
make docker-run              # foreground
make docker-run-bg           # detached
make docker-stop
```

The container honors `PORT` (default `3000`).

## Railway

[`railway.toml`](../railway.toml) is pre-configured for a Dockerfile build:

```toml
[build]
builder = "DOCKERFILE"
dockerfilePath = "Dockerfile"

[deploy]
startCommand = "node server.cjs"
healthcheckPath = "/healthz"
healthcheckTimeout = 30
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 5
```

Push the repo to a Railway service and it will:

1. Detect `railway.toml`
2. Build the Dockerfile
3. Run `node server.cjs` and probe `/healthz` until it returns 200
4. Restart up to 5 times on failure

Railway sets `PORT` for you — the server reads it.

## Render / Fly.io / Cloud Run / anywhere with Docker

Any platform that runs containers will work. The contract is:

- Listen on `process.env.PORT` (default `3000`)
- Respond `200 OK` to `GET /healthz`
- Stateless — no volumes, no DB, no sticky sessions

Examples:

### Render (Docker)

Point Render at the Dockerfile, set the health check to `/healthz`, and let it pick the port from `$PORT`.

### Fly.io

```bash
fly launch --image-label distrosim --no-deploy
fly deploy
```

Fly's `fly.toml` should set `internal_port = 3000` (or set `PORT` to whatever the platform expects).

### Cloud Run

```bash
gcloud run deploy distrosim --source . --port 3000 --allow-unauthenticated
```

## Health checks

```
GET /healthz → { "status": "ok" }
```

Returns 200 unconditionally as long as the process is up. There's no deeper check — the simulation runs in the browser, so server health is just "process alive".

## Caching headers

[`server.cts`](../server.cts) sets:

- `Cache-Control: no-cache` for `*.html`
- `Cache-Control: max-age=3600` for everything else

This lets browsers cache hashed JS/CSS bundles (which Vite produces) while always re-fetching `index.html`. If you put a CDN in front, you can be more aggressive on hashed assets.

## Environment variables

| Variable | Default | Used by             |
|----------|---------|---------------------|
| `PORT`   | `3000`  | Express listen port |

That's it. There is no other configuration.

## Build artifacts in version control

`dist/` and `server.cjs` are ignored by `.gitignore` and recreated on every build. Don't commit them.
