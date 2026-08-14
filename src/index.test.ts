import { describe, expect, it, vi } from 'vitest';
import { main } from './index.js';

describe('main', () => {
  it('runs', () => {
    expect(() => {
      main();
    }).not.toThrow();
  });

  it('logs ok', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    main();
    expect(logSpy).toHaveBeenCalledWith('ok');
    logSpy.mockRestore();
  });
});
