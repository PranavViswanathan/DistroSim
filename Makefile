# DistroSim — distributed systems simulator
# Common dev/build/deploy targets. Use `make help` to list them.

PORT          ?= 3000
DEV_PORT      ?= 5173
IMAGE         ?= distrosim
TAG           ?= latest
PID_DIR       := .pids
DEV_PID       := $(PID_DIR)/dev.pid
SERVE_PID     := $(PID_DIR)/serve.pid
DEV_LOG       := $(PID_DIR)/dev.log
SERVE_LOG     := $(PID_DIR)/serve.log

.DEFAULT_GOAL := help

# ---------- Help ----------

.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*?## "; printf "\nDistroSim targets:\n\n"} \
	  /^[a-zA-Z0-9_.-]+:.*?## / {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}' \
	  $(MAKEFILE_LIST)
	@echo ""
	@echo "Vars:  PORT=$(PORT)  DEV_PORT=$(DEV_PORT)  IMAGE=$(IMAGE)  TAG=$(TAG)"
	@echo ""

# ---------- Install ----------

.PHONY: install
install: ## Install npm dependencies
	npm install

node_modules: package.json package-lock.json
	npm install
	@touch node_modules

# ---------- Dev ----------

.PHONY: dev
dev: node_modules ## Run vite dev server in the foreground
	npm run dev

.PHONY: dev-bg
dev-bg: node_modules $(PID_DIR) ## Start vite dev server in the background
	@if [ -f $(DEV_PID) ] && kill -0 $$(cat $(DEV_PID)) 2>/dev/null; then \
	  echo "dev server already running (pid $$(cat $(DEV_PID)))"; \
	else \
	  nohup npm run dev > $(DEV_LOG) 2>&1 & echo $$! > $(DEV_PID); \
	  sleep 1; \
	  echo "dev server started → http://localhost:$(DEV_PORT)/  (pid $$(cat $(DEV_PID)))"; \
	fi

.PHONY: dev-stop
dev-stop: ## Stop the background dev server
	@if [ -f $(DEV_PID) ]; then \
	  kill $$(cat $(DEV_PID)) 2>/dev/null || true; \
	  rm -f $(DEV_PID); \
	  echo "dev server stopped"; \
	else \
	  echo "no dev pid file"; \
	fi

.PHONY: dev-logs
dev-logs: ## Tail vite dev server logs
	@touch $(DEV_LOG); tail -f $(DEV_LOG)

# ---------- Build ----------

.PHONY: build
build: node_modules ## Build vite client + compile server
	npm run build

.PHONY: typecheck
typecheck: node_modules ## Typecheck client without emitting
	npx tsc --noEmit -p tsconfig.json

# ---------- Production server ----------

.PHONY: start
start: build ## Build then run the production server (foreground)
	PORT=$(PORT) node server.cjs

.PHONY: serve
serve: ## Run the production server (foreground, no rebuild)
	PORT=$(PORT) node server.cjs

.PHONY: serve-bg
serve-bg: $(PID_DIR) ## Run the production server in the background
	@if [ -f $(SERVE_PID) ] && kill -0 $$(cat $(SERVE_PID)) 2>/dev/null; then \
	  echo "server already running (pid $$(cat $(SERVE_PID)))"; \
	else \
	  PORT=$(PORT) nohup node server.cjs > $(SERVE_LOG) 2>&1 & echo $$! > $(SERVE_PID); \
	  sleep 1; \
	  echo "server started → http://localhost:$(PORT)/  (pid $$(cat $(SERVE_PID)))"; \
	fi

.PHONY: stop
stop: ## Stop the background production server
	@if [ -f $(SERVE_PID) ]; then \
	  kill $$(cat $(SERVE_PID)) 2>/dev/null || true; \
	  rm -f $(SERVE_PID); \
	  echo "server stopped"; \
	else \
	  echo "no server pid file"; \
	fi

.PHONY: restart
restart: stop serve-bg ## Restart the background production server

.PHONY: logs
logs: ## Tail production server logs
	@touch $(SERVE_LOG); tail -f $(SERVE_LOG)

.PHONY: status
status: ## Show running dev/server pids
	@echo "dev:    $$([ -f $(DEV_PID) ] && cat $(DEV_PID) || echo stopped)"
	@echo "serve:  $$([ -f $(SERVE_PID) ] && cat $(SERVE_PID) || echo stopped)"
	@if [ -f $(SERVE_PID) ] && kill -0 $$(cat $(SERVE_PID)) 2>/dev/null; then \
	  curl -s -o /dev/null -w "health: %{http_code}\n" http://localhost:$(PORT)/healthz || true; \
	fi

.PHONY: kill-all
kill-all: dev-stop stop ## Stop both dev and production servers

# ---------- Docker ----------

.PHONY: docker-build
docker-build: ## Build the docker image
	docker build -t $(IMAGE):$(TAG) .

.PHONY: docker-run
docker-run: ## Run the docker image (foreground)
	docker run --rm -p $(PORT):3000 --name $(IMAGE) $(IMAGE):$(TAG)

.PHONY: docker-run-bg
docker-run-bg: ## Run the docker image (detached)
	docker run -d --rm -p $(PORT):3000 --name $(IMAGE) $(IMAGE):$(TAG)
	@echo "container running → http://localhost:$(PORT)/"

.PHONY: docker-stop
docker-stop: ## Stop the docker container
	-@docker stop $(IMAGE) 2>/dev/null || true

.PHONY: docker-logs
docker-logs: ## Tail docker container logs
	docker logs -f $(IMAGE)

# ---------- Cleanup ----------

.PHONY: clean
clean: ## Remove build artifacts and pid files
	rm -rf dist server.cjs $(PID_DIR)

.PHONY: distclean
distclean: clean ## Also remove node_modules
	rm -rf node_modules

# ---------- Internal ----------

$(PID_DIR):
	@mkdir -p $(PID_DIR)
