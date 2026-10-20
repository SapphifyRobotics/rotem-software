import { expect, it, vi } from 'vitest';
vi.mock('three', async (original) => {
 const actual = await original<typeof import('three')>();
 return {...actual, WebGLRenderer: class { constructor() { throw new Error('WebGL unavailable'); } }};
});
import { BoardView } from '../src/scene';
it('propagates WebGL failure so the application selects its live Canvas fallback', () => {
 const append = vi.fn();
 expect(() => new BoardView({appendChild: append} as unknown as HTMLElement)).toThrow('WebGL unavailable');
 expect(append).not.toHaveBeenCalled();
});
