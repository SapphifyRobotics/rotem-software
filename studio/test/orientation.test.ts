import { describe, it, expect } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { sensorToDisplayQuaternion, CAD_TO_DISPLAY_X } from '../src/orientation';
describe('physical sensor to display coordinate contract', () => {
 it('places CAD board normal upward at level', () => {
  const normal = new Vector3(0,0,1).applyAxisAngle(new Vector3(1,0,0),CAD_TO_DISPLAY_X);
  expect(normal.y).toBeCloseTo(1); expect(normal.z).toBeCloseTo(0);
 });
 it('maps a 90 degree physical yaw to display Y, not display Z', () => {
  const q = new Quaternion(...sensorToDisplayQuaternion([Math.SQRT1_2,0,0,Math.SQRT1_2])!);
  const right = new Vector3(1,0,0).applyQuaternion(q);
  expect(right.x).toBeCloseTo(0); expect(right.y).toBeCloseTo(0); expect(right.z).toBeCloseTo(-1);
 });
 it('normalizes quantized input and rejects malformed orientation', () => {
  expect(sensorToDisplayQuaternion([10000,0,0,0])).toEqual([0,0,-0,1]);
  for (const q of [[0,0,0,0],[NaN,0,0,0],[1,2,3]]) expect(sensorToDisplayQuaternion(q)).toBeNull();
 });
});
