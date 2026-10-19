/** Sensor frame is X/right, Y/USB, Z/up. Three.js uses Y/up.
 * The basis change is a -90° rotation around X: (x,y,z) -> (x,z,-y).
 * Firmware and fusion quaternions arrive in [w,x,y,z] order.
 */
export function sensorToDisplayQuaternion(q: readonly number[]): [number, number, number, number] | null {
  if (q.length !== 4 || !q.every(Number.isFinite)) return null;
  const norm = Math.hypot(...q);
  if (norm < 1e-8) return null;
  return [q[1] / norm, q[3] / norm, -q[2] / norm, q[0] / norm];
}
export const CAD_TO_DISPLAY_X = -Math.PI / 2;
