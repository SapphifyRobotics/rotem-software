import { describe, expect, it } from 'vitest';
// @ts-expect-error plain Node helper is also used by the local server
import { allowedRequest } from '../server/origin.mjs';
describe('local hub boundary', () => {
 it('only accepts the exact local origin for WebSocket commands', () => {
  for (const origin of ['http://evil.example', 'null', 'http://localhost:9999', undefined])
   expect(allowedRequest({headers:{host:'localhost:4747',origin}},true)).toBe(false);
  expect(allowedRequest({headers:{host:'localhost:4747',origin:'http://localhost:4747'}},true)).toBe(true);
 });
 it('rejects rebinding hosts and allows local read-only status', () => {
  expect(allowedRequest({headers:{host:'evil.example'}},false)).toBe(false);
  expect(allowedRequest({headers:{host:'127.0.0.1:4747'}},false)).toBe(true);
 });
});
