// Magnetometer-to-board axis maps. The MMC5983MA sits rotated 180 degrees beside the IMU
// (KiCad U2 pin 1 bottom-left, U1 pin 1 top-left) and its datasheet frame has +Z into the
// package, so the default (index 0) is board = (mx, my, -mz). All 48 signed permutations
// are listed so a calibration can pick the one the data supports (findMagAxes).

export type Mat3 = number[][];

function build(): Mat3[] {
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const out: Mat3[] = [];
  for (const p of perms) for (let s = 0; s < 8; s++) {
    const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let r = 0; r < 3; r++) m[r][p[r]] = (s >> r) & 1 ? -1 : 1;
    out.push(m);
  }
  const def = out.findIndex((m) => m[0][0] === 1 && m[1][1] === 1 && m[2][2] === -1);
  [out[0], out[def]] = [out[def], out[0]];
  return out;
}
export const MAG_AXES: Mat3[] = build();

export const apply = (m: Mat3, v: number[]) => [0, 1, 2].map((r) => m[r][0] * v[0] + m[r][1] * v[1] + m[r][2] * v[2]);
export function describe(m: Mat3): string {
  return m.map((row, r) => {
    const c = row.findIndex((v) => v !== 0);
    return `${'xyz'[r]}=${row[c] < 0 ? '-' : ''}m${'xyz'[c]}`;
  }).join(' ');
}

export interface RotSample { t: number; gyro: number[]; mag: number[]; accel: number[] } // s, rad/s and g (board), calibrated mag (sensor frame)

/** Pick the axis map under which the field turns against the gyro as a fixed vector should:
 *  dm/dt = -w x m in the board frame. That rule cannot tell a map from its negative, so the sign is
 *  chosen by the dip: north of the magnetic equator the field points down, against the accelerometer's
 *  "up" (set northern = false south of it). Returns the index, the fit, and how much better it is than
 *  the best map that is not its negative. */
export function findMagAxes(samples: RotSample[], northern = true): { index: number; residual: number; margin: number; motion: number; dip: number } | null {
  if (samples.length < 40) return null;
  const scores = MAG_AXES.map(() => 0);
  let motion = 0;
  for (let k = 1; k < samples.length; k++) {
    const a = samples[k - 1], b = samples[k], dt = b.t - a.t;
    if (dt <= 0 || dt > 0.3) continue;
    const w = [0, 1, 2].map((i) => (a.gyro[i] + b.gyro[i]) / 2);
    motion += Math.hypot(...w) * dt;
    MAG_AXES.forEach((M, idx) => {
      const ma = apply(M, a.mag), mb = apply(M, b.mag);
      const m = [0, 1, 2].map((i) => (ma[i] + mb[i]) / 2);
      const dm = [0, 1, 2].map((i) => (mb[i] - ma[i]) / dt);
      const cross = [w[1] * m[2] - w[2] * m[1], w[2] * m[0] - w[0] * m[2], w[0] * m[1] - w[1] * m[0]];
      scores[idx] += (dm[0] + cross[0]) ** 2 + (dm[1] + cross[1]) ** 2 + (dm[2] + cross[2]) ** 2;
    });
  }
  const order = scores.map((s, i) => [s, i]).sort((x, y) => x[0] - y[0]);
  const best = MAG_AXES[order[0][1]];
  const negIdx = (i: number) => MAG_AXES.findIndex((m) => m.every((row, r) => row.every((v, c) => v === -MAG_AXES[i][r][c])));
  const pair = [order[0][1], negIdx(order[0][1])];
  const rival = order.find(([, i]) => !pair.includes(i))!;
  // Dip: mean angle between the field and "up" (the accelerometer at rest reads +1 g up).
  let dot = 0, n = 0;
  for (const s of samples) {
    const m = apply(best, s.mag), an = Math.hypot(...s.accel), mn = Math.hypot(...m);
    if (an < 0.8 || an > 1.2 || !mn) continue;
    dot += (m[0] * s.accel[0] + m[1] * s.accel[1] + m[2] * s.accel[2]) / (an * mn); n++;
  }
  const upDot = n ? dot / n : 0;
  const index = (upDot < 0) === northern ? pair[0] : pair[1];
  const dip = Math.asin(Math.min(1, Math.abs(upDot))) * 180 / Math.PI;
  return { index, residual: order[0][0], margin: rival[0] / Math.max(order[0][0], 1e-12), motion, dip };
}
