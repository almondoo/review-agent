import type { PRRef, VCS } from './vcs.js';

/**
 * Branded `PlatformId` so callers cannot accidentally pass a raw
 * `string` where the registry expects a registered platform key. The
 * brand is purely a compile-time type — at runtime it is a regular
 * string.
 *
 * **Intentional limitation:** `PRRef.platform` (in `vcs.ts`) keeps its
 * `'github' | 'codecommit'` literal-union shape so JobMessage rows
 * already persisted to SQS / Postgres parse without a schema bump.
 * Widening to plain `string` is v2 work (DB migration + JobMessage
 * schema version). The registry is a dispatch helper, not a
 * type-erasure layer.
 */
export type PlatformId = string & { readonly __brand: 'PlatformId' };

/**
 * Adapter packages export one of these and call {@link registerPlatform}
 * with it at module load. The `create` factory receives an opaque
 * `unknown` config — adapter-specific shape — and must validate before
 * use. See `packages/platform-github/src/platform.ts` and
 * `packages/platform-codecommit/src/platform.ts` for the in-tree
 * examples.
 */
export type PlatformDefinition<TRef extends PRRef = PRRef> = {
  readonly id: PlatformId;
  /**
   * Parse a free-form ref descriptor (e.g. `'owner/repo#42'` or
   * `'arn:aws:codecommit:...#42'`) into a typed {@link PRRef}.
   * Adapters can throw on malformed input; callers must catch.
   */
  readonly parseRef: (input: string) => TRef;
  /**
   * Build a VCS adapter instance from adapter-specific config.
   * Implementations must validate the config object before use — the
   * registry intentionally types it as `unknown` to avoid coupling
   * `@review-agent/core` to every adapter's config shape.
   */
  readonly create: (config: unknown) => VCS;
};

const REGISTRY = new Map<PlatformId, PlatformDefinition>();

/**
 * Coerce a raw string into a {@link PlatformId}. Useful in test
 * helpers and CLI code; the registry does not require a particular
 * casing.
 */
export function platformId(id: string): PlatformId {
  return id as PlatformId;
}

/**
 * Register an adapter under its platform id. Idempotent **only** when
 * the same definition object is registered twice — a second
 * registration under the same id with a different definition throws,
 * because it is almost always a mis-configuration (two adapter
 * packages racing under the same id). Test helpers that need to swap
 * a registration must call {@link unregisterPlatform} first.
 */
export function registerPlatform(def: PlatformDefinition): void {
  const existing = REGISTRY.get(def.id);
  if (existing && existing !== def) {
    throw new Error(
      `Platform '${def.id}' is already registered with a different definition; unregister it first.`,
    );
  }
  REGISTRY.set(def.id, def);
}

/**
 * Remove a platform from the registry. Intended for tests that want to
 * isolate registration state across cases; production code should not
 * need this.
 */
export function unregisterPlatform(id: PlatformId | string): boolean {
  return REGISTRY.delete(id as PlatformId);
}

/**
 * Resolve a platform definition by id. Throws when the id is not
 * registered — fail-loud is preferred over a silent fallback because a
 * mis-registered adapter means the worker would otherwise post
 * comments under the wrong platform.
 */
export function getPlatform(id: PlatformId | string): PlatformDefinition {
  const def = REGISTRY.get(id as PlatformId);
  if (!def) {
    const known = Array.from(REGISTRY.keys()).join(', ') || '(none)';
    throw new Error(`Unknown platform '${id}'. Registered platforms: ${known}.`);
  }
  return def;
}

/**
 * List the ids of every currently-registered platform. Order is
 * insertion order from the Map.
 */
export function listPlatforms(): ReadonlyArray<PlatformId> {
  return Array.from(REGISTRY.keys());
}

/**
 * Test-only: drop every registration. Production code MUST NOT call
 * this — a worker that resets the registry mid-flight loses its
 * adapter dispatch.
 */
export function _resetPlatformRegistryForTests(): void {
  REGISTRY.clear();
}
