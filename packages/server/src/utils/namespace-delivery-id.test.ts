import { describe, expect, it } from 'vitest';
import { namespaceDeliveryId } from './namespace-delivery-id.js';

describe('namespaceDeliveryId', () => {
  it('prefixes github delivery ids with gh:', () => {
    expect(namespaceDeliveryId('github', 'dlv-1')).toBe('gh:dlv-1');
  });

  it('prefixes codecommit delivery ids with sns:', () => {
    expect(namespaceDeliveryId('codecommit', 'm-1')).toBe('sns:m-1');
  });

  it('does not collide when the same id is namespaced for two platforms', () => {
    const id = 'shared-uuid';
    expect(namespaceDeliveryId('github', id)).not.toBe(namespaceDeliveryId('codecommit', id));
  });
});
