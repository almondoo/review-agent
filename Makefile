.DEFAULT_GOAL := help
.PHONY: help setup install dev dev-mock dev-web dev-server build typecheck lint test test-coverage clean

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
