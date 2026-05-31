# @review-agent/web

Dashboard SPA for review-agent — a self-hosted, multi-provider AI code review agent.

## Design direction

Brutalist Editorial. Raw typographic hierarchy over decorative chrome. Ink on paper palette (`--ink` / `--paper`). Fraunces serif for display headings, Bricolage Grotesque for UI text, JetBrains Mono for code and data. Grain overlay, hairlines, and status badges in muted rust and moss replace conventional pastel UI kits.

## Commands

```sh
# Development (proxies /api to localhost:8080)
pnpm --filter @review-agent/web dev

# Development with mock data (no backend required)
pnpm --filter @review-agent/web dev --mode mock

# Type-check
pnpm --filter @review-agent/web typecheck

# Lint
pnpm --filter @review-agent/web lint

# Production build
pnpm --filter @review-agent/web build

# Tests
pnpm --filter @review-agent/web test
```

## Mock mode

Two equivalent ways to run with mock data (no backend required):

**Option A — Vite mode flag:**
```sh
pnpm --filter @review-agent/web dev --mode mock
```
This loads `vite.config.ts` with the `mock` mode, which sets `VITE_USE_MOCK=true` automatically if you add a `.env.mock` file:

```sh
# packages/web/.env.mock
VITE_USE_MOCK=true
```

**Option B — Local env file:**
Create `packages/web/.env.local` with:
```
VITE_USE_MOCK=true
```
Then run `pnpm --filter @review-agent/web dev` as usual.

## API mode (real backend)

Start the server in a separate terminal:
```sh
pnpm --filter @review-agent/server dev
```
Then start the web dev server (no mock flag). The Vite dev server proxies `/api/*` to `http://localhost:8080`.

## Environment variables

| Env | Required | Description |
|-----|----------|-------------|
| `VITE_USE_MOCK` | no | `"true"` でモックモード |
| `VITE_REVIEW_AGENT_DASHBOARD_TOKEN` | yes (prod) | Bearer token sent to `/api/*`. Must match server-side `REVIEW_AGENT_DASHBOARD_TOKEN`. |

## Test helpers

`src/test/render.tsx` exports `renderWithProviders(ui, { route? })` — wraps the component in `QueryClientProvider` (with `retry: false`) and `MemoryRouter`. Use this in all component tests.

`src/test/setup.ts` — imported by Vitest via `setupFiles`. Registers `@testing-library/jest-dom` matchers and calls `cleanup` after each test.
