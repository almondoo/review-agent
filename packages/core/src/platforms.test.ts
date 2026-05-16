import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetPlatformRegistryForTests,
  getPlatform,
  listPlatforms,
  type PlatformDefinition,
  platformId,
  registerPlatform,
  unregisterPlatform,
} from './platforms.js';
import { createFakeVCS } from './test-helpers.js';
import type { PRRef } from './vcs.js';

const refOf = (n: number): PRRef => ({ platform: 'github', owner: 'o', repo: 'r', number: n });

function makeDef(id: string, overrides: Partial<PlatformDefinition> = {}): PlatformDefinition {
  return {
    id: platformId(id),
    parseRef: (input: string) => ({ ...refOf(1), repo: input }),
    create: () => createFakeVCS(),
    ...overrides,
  };
}

describe('platform registry', () => {
  afterEach(() => {
    _resetPlatformRegistryForTests();
  });

  it('registers a platform and resolves it by id', () => {
    const def = makeDef('test-a');
    registerPlatform(def);
    expect(getPlatform('test-a')).toBe(def);
    expect(listPlatforms()).toEqual([platformId('test-a')]);
  });

  it('is idempotent when the same definition object is registered twice', () => {
    const def = makeDef('test-b');
    registerPlatform(def);
    expect(() => registerPlatform(def)).not.toThrow();
    expect(listPlatforms()).toHaveLength(1);
  });

  it('throws when a different definition is registered under the same id', () => {
    const a = makeDef('test-c');
    const b = makeDef('test-c');
    registerPlatform(a);
    expect(() => registerPlatform(b)).toThrow(/already registered/);
  });

  it('throws a helpful error when resolving an unknown platform', () => {
    expect(() => getPlatform('nope')).toThrow(/Unknown platform 'nope'/);
  });

  it('lists every registered platform in insertion order', () => {
    registerPlatform(makeDef('a'));
    registerPlatform(makeDef('b'));
    registerPlatform(makeDef('c'));
    expect(listPlatforms()).toEqual([platformId('a'), platformId('b'), platformId('c')]);
  });

  it('unregisterPlatform removes the entry and returns true on a hit', () => {
    const def = makeDef('drop');
    registerPlatform(def);
    expect(unregisterPlatform('drop')).toBe(true);
    expect(listPlatforms()).toEqual([]);
    expect(unregisterPlatform('drop')).toBe(false);
  });

  it('exhaustiveness: every registered platform exposes the full VCS interface', () => {
    registerPlatform(makeDef('ex-a'));
    registerPlatform(makeDef('ex-b'));
    for (const id of listPlatforms()) {
      const vcs = getPlatform(id).create({});
      expect(typeof vcs.getPR).toBe('function');
      expect(typeof vcs.getDiff).toBe('function');
      expect(typeof vcs.getFile).toBe('function');
      expect(typeof vcs.cloneRepo).toBe('function');
      expect(typeof vcs.postReview).toBe('function');
      expect(typeof vcs.postSummary).toBe('function');
      expect(typeof vcs.getExistingComments).toBe('function');
      expect(typeof vcs.getStateComment).toBe('function');
      expect(typeof vcs.upsertStateComment).toBe('function');
      expect(vcs.capabilities).toBeDefined();
      expect(typeof vcs.capabilities.clone).toBe('boolean');
    }
  });
});
