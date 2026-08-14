import { describe, expect, it } from 'vitest';
import { main } from './index.js';

describe('main', () => {
  it('runs', () => {
    expect(() => main()).not.toThrow();
  });
});
