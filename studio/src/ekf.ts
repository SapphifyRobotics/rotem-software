// Multiplicative extended Kalman filter: attitude quaternion (body to world, [w,x,y,z])
// and gyro bias. Error state: 3 attitude-error angles in the body frame, 3 bias terms.
// Gyro drives the prediction; gravity (accelerometer) and, optionally, magnetic heading
// correct it. Same frame and Euler convention as Madgwick in ahrs.ts.

type M = number[][];
const zeros = (r: number, c: number): M =>
  Array.from({ length: r }, () => new Array(c).fill(0));
const eye = (n: number): M => {
  const m = zeros(n, n);
  for (let i = 0; i < n; i++) m[i][i] = 1;
  return m;
};
const mul = (a: M, b: M): M => {
  const r = zeros(a.length, b[0].length);
  for (let i = 0; i < a.length; i++)
    for (let k = 0; k < b.length; k++) {
      const v = a[i][k];
      if (!v) continue;
      for (let j = 0; j < b[0].length; j++) r[i][j] += v * b[k][j];
    }
  return r;
};
const tr = (a: M): M => a[0].map((_, j) => a.map((row) => row[j]));
const add = (a: M, b: M): M =>
  a.map((row, i) => row.map((v, j) => v + b[i][j]));
const sub = (a: M, b: M): M =>
  a.map((row, i) => row.map((v, j) => v - b[i][j]));
function inv3(m: M): M {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h,
    B = -(d * i - f * g),
    C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}
const skew = (v: number[]): M => [
  [0, -v[2], v[1]],
  [v[2], 0, -v[0]],
  [-v[1], v[0], 0],
];

export interface EkfParams {
  zeroRate: boolean; // learn the gyro bias (all three axes) whenever the board is still
  holdStill?: boolean; // while still, the true rotation is zero: do not integrate the gyro at all (heading holds)
  gyroNoise: number; // rad/s/sqrt(Hz), angle random walk
  biasNoise: number; // rad/s^2/sqrt(Hz), bias random walk
  accelNoise: number; // g, accelerometer measurement noise
  headingNoise: number; // rad, magnetic heading noise
}
export const EKF_DEFAULTS: EkfParams = {
  zeroRate: true,
  holdStill: true,
  gyroNoise: 0.004,
  biasNoise: 0.0002,
  accelNoise: 0.03,
  headingNoise: 0.15,
};

/** Stillness detector: over a sliding window, the gyro and the accelerometer barely change and the
 *  accelerometer reads 1 g. While still, the true rotation rate is zero, so the gyro reading *is* its bias. */
export class StillDetector {
  private g: number[][] = [];
  private a: number[][] = [];
  // samples, rad/s, g, rad/s. maxRate: a steady turn has no variance, so the mean rate must be small too;
  // 0.01 rad/s (0.57 deg/s) is above any bias seen on the ICM-45686 and below any deliberate motion.
  constructor(
    public window = 50,
    public gyroStd = 0.012,
    public accelStd = 0.006,
    public maxRate = 0.01,
  ) {}
  push(gyro: number[], accel: number[]): boolean {
    this.g.push(gyro);
    this.a.push(accel);
    if (this.g.length > this.window) {
      this.g.shift();
      this.a.shift();
    }
    if (this.g.length < this.window) return false;
    const sd = (rows: number[][]) =>
      Math.max(
        ...[0, 1, 2].map((i) => {
          const m = rows.reduce((s, r) => s + r[i], 0) / rows.length;
          return Math.sqrt(
            rows.reduce((s, r) => s + (r[i] - m) ** 2, 0) / rows.length,
          );
        }),
      );
    const an = Math.hypot(...accel);
    const mean = [0, 1, 2].map(
      (i) => this.g.reduce((s, r) => s + r[i], 0) / this.g.length,
    );
    return (
      sd(this.g) < this.gyroStd &&
      sd(this.a) < this.accelStd &&
      Math.abs(an - 1) < 0.05 &&
      Math.hypot(...mean) < this.maxRate
    );
  }
  reset() {
    this.g = [];
    this.a = [];
  }
}

export class AttitudeEkf {
  q: [number, number, number, number] = [1, 0, 0, 0];
  bias = [0, 0, 0];
  still = false;
  private detector = new StillDetector();
  P: M = eye(6).map((r, i) => r.map((v) => v * (i < 3 ? 0.1 : 1e-4)));
  constructor(public p: EkfParams = { ...EKF_DEFAULTS }) {}

  reset() {
    this.q = [1, 0, 0, 0];
    this.bias = [0, 0, 0];
    this.P = new AttitudeEkf().P;
    this.detector.reset();
    this.still = false;
  }

  private R(): M {
    const [w, x, y, z] = this.q;
    return [
      [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
      [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
      [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ];
  }

  private rotate(dtheta: number[]) {
    const [w, x, y, z] = this.q,
      [a, b, c] = dtheta.map((v) => v / 2);
    const q = [
      w - x * a - y * b - z * c,
      x + w * a + y * c - z * b,
      y + w * b - x * c + z * a,
      z + w * c + x * b - y * a,
    ];
    const n = Math.hypot(...q);
    this.q = [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
  }

  /** axisFree: a body-frame unit vector the measurement cannot observe; the attitude correction along it is removed
   *  (gravity says nothing about rotation about the vertical, so it must not move the heading). */
  private correct(H: M, innovation: number[], Rm: M, axisFree?: number[]) {
    const PHt = mul(this.P, tr(H));
    const S = add(mul(H, PHt), Rm);
    const Sinv = S.length === 1 ? [[1 / S[0][0]]] : inv3(S);
    const K = mul(PHt, Sinv);
    const dx = mul(
      K,
      innovation.map((v) => [v]),
    ).map((r) => r[0]);
    if (axisFree) {
      const d = dx[0] * axisFree[0] + dx[1] * axisFree[1] + dx[2] * axisFree[2];
      for (let i = 0; i < 3; i++) dx[i] -= d * axisFree[i];
    }
    this.rotate(dx.slice(0, 3));
    for (let i = 0; i < 3; i++) this.bias[i] += dx[3 + i];
    const IKH = sub(eye(6), mul(K, H));
    // Joseph form keeps P symmetric and positive.
    this.P = add(mul(mul(IKH, this.P), tr(IKH)), mul(mul(K, Rm), tr(K)));
  }

  /** gyro rad/s, accel in g, mag any unit or null, dt seconds */
  update(gyro: number[], accel: number[], mag: number[] | null, dt: number) {
    // Stillness first: it decides whether this step integrates the gyro at all.
    this.still = this.p.zeroRate !== false && this.detector.push(gyro, accel);
    const hold = this.still && this.p.holdStill !== false;
    const w = hold ? [0, 0, 0] : gyro.map((v, i) => v - this.bias[i]);
    this.rotate(w.map((v) => v * dt));
    const F = eye(6);
    const wx = skew(w);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        F[i][j] -= wx[i][j] * dt;
      }
    for (let i = 0; i < 3; i++) F[i][3 + i] = -dt;
    const Q = zeros(6, 6);
    for (let i = 0; i < 3; i++) {
      Q[i][i] = this.p.gyroNoise ** 2 * dt;
      Q[3 + i][3 + i] = this.p.biasNoise ** 2 * dt;
    }
    this.P = add(mul(mul(F, this.P), tr(F)), Q);

    // Zero-rate update: while still, the gyro reading measures the bias directly (H = [0 I]).
    if (this.still) {
      const H = zeros(3, 6);
      for (let i = 0; i < 3; i++) H[i][3 + i] = 1;
      const rz = (this.p.gyroNoise * 4) ** 2; // per-sample gyro noise at ~100 Hz, white
      this.correct(
        H,
        gyro.map((v, i) => v - this.bias[i]),
        eye(3).map((r) => r.map((v) => v * rz)),
      );
    }

    const an = Math.hypot(accel[0], accel[1], accel[2]);
    if (an > 0.3 && an < 3) {
      const R = this.R();
      const gb = [R[2][0], R[2][1], R[2][2]]; // world up seen in the body frame
      const z = accel.map((v) => v / an);
      const H = zeros(3, 6);
      const s = skew(gb);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) H[i][j] = s[i][j];
      // Trust gravity less while the board accelerates.
      const sigma = this.p.accelNoise * (1 + 20 * Math.abs(an - 1));
      this.correct(
        H,
        z.map((v, i) => v - gb[i]),
        eye(3).map((r) => r.map((v) => v * sigma * sigma)),
        gb,
      );
    }

    if (mag) {
      // Heading: rotate the field into the world frame with the current estimate; its horizontal
      // part should lie along world +x (magnetic north). The angle it is off by is the yaw error.
      const R = this.R();
      const mw = [0, 1, 2].map(
        (r) => R[r][0] * mag[0] + R[r][1] * mag[1] + R[r][2] * mag[2],
      );
      if (Math.hypot(mw[0], mw[1]) > 1e-6) {
        const innov = -Math.atan2(mw[1], mw[0]);
        const H = [[R[2][0], R[2][1], R[2][2], 0, 0, 0]]; // yaw response to a body-frame attitude error
        this.correct(H, [innov], [[this.p.headingNoise ** 2]]);
      }
    }
  }

  euler(): [number, number, number] {
    const [w, x, y, z] = this.q,
      d = 180 / Math.PI;
    return [
      Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) * d,
      Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x)))) * d,
      Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * d,
    ];
  }

  /** 1-sigma attitude uncertainty, degrees */
  sigmaDeg(): number[] {
    return [0, 1, 2].map((i) => (Math.sqrt(this.P[i][i]) * 180) / Math.PI);
  }
}
