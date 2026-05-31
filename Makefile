.DEFAULT_GOAL := help
.PHONY: help setup install dev dev-mock dev-web dev-server build typecheck lint test test-coverage clean \
        db-up db-down db-logs db-migrate dev-stack dev-full

help: ## Show available targets
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup install: ## Install workspace dependencies via pnpm
	pnpm install

dev: ## Start web + server concurrently (requires DATABASE_URL)
	pnpm -r --parallel --filter "@review-agent/web" --filter "@review-agent/server" dev

dev-mock: ## Start web in mock mode (no DB / server required)
	VITE_USE_MOCK=true pnpm --filter @review-agent/web dev

dev-web: ## Start web only (assumes server is already running)
	pnpm --filter @review-agent/web dev

dev-server: ## Start server only (requires DATABASE_URL in env or .env.local)
	pnpm --filter @review-agent/server dev

build: ## Build all packages
	pnpm -r build

typecheck: ## Run TypeScript type-check across all packages
	pnpm -r typecheck

lint: ## Run Biome lint + format check
	pnpm lint

test: ## Run all package tests
	pnpm -r test

test-coverage: ## Run all package tests with coverage
	pnpm -r test:coverage

clean: ## Remove build outputs and node_modules
	rm -rf packages/*/dist packages/*/node_modules node_modules

# --- Dev dependencies (docker-compose.dev.yml) ---

db-up: ## Start Postgres + ElasticMQ via docker-compose.dev.yml
	docker compose -f docker-compose.dev.yml up -d
	@echo "[dev] waiting for Postgres to be healthy..."
	@until docker compose -f docker-compose.dev.yml ps postgres | grep -q 'healthy'; do sleep 1; done
	@echo "[dev] Postgres ready at postgresql://review:review@localhost:5435/review_agent"

db-down: ## Stop Postgres + ElasticMQ (keeps data volume)
	docker compose -f docker-compose.dev.yml down

db-logs: ## Tail dev Postgres logs
	docker compose -f docker-compose.dev.yml logs -f postgres

db-migrate: ## Run Drizzle migrations against the dev Postgres
	DATABASE_URL=postgresql://review:review@localhost:5435/review_agent \
	  pnpm --filter @review-agent/db db:migrate

dev-stack: ## db-up + dev (web + server) in one shot
	$(MAKE) db-up
	$(MAKE) dev

dev-full: ## db-up + db-migrate + dev (web + server) in one shot
	$(MAKE) db-up
	$(MAKE) db-migrate
	$(MAKE) dev
