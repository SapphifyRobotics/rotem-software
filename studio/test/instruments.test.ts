import { describe, expect, it } from 'vitest';
import { drawCompass, drawHorizon } from '../src/instruments';

describe('responsive instruments', () => {
  it('does not draw an instrument hidden by the mobile breakpoint', () => {
    const hidden = { clientWidth: 0, clientHeight: 0, getContext() { throw new Error('hidden canvas must not be drawn'); } } as unknown as HTMLCanvasElement;
    expect(() => drawCompass(hidden, 90)).not.toThrow();
    expect(() => drawHorizon(hidden, 10, 20)).not.toThrow();
  });
});
