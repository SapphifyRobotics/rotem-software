// Madgwick orientation filter (IMU and MARG forms). Quaternion [w, x, y, z], sensor frame.

export class Madgwick {
  q: [number, number, number, number] = [1, 0, 0, 0];
  constructor(public beta = 0.08) {}

  reset() { this.q = [1, 0, 0, 0]; }

  /** gyro rad/s, accel any unit, mag any unit or null, dt seconds */
  update(g: number[], a: number[], m: number[] | null, dt: number) {
    let [q0, q1, q2, q3] = this.q;
    let [gx, gy, gz] = g; let [ax, ay, az] = a;
    let qd0 = 0.5 * (-q1 * gx - q2 * gy - q3 * gz);
    let qd1 = 0.5 * (q0 * gx + q2 * gz - q3 * gy);
    let qd2 = 0.5 * (q0 * gy - q1 * gz + q3 * gx);
    let qd3 = 0.5 * (q0 * gz + q1 * gy - q2 * gx);
    const an = Math.hypot(ax, ay, az);
    if (an > 0) {
      ax /= an; ay /= an; az /= an;
      let s0: number, s1: number, s2: number, s3: number;
      const mn = m ? Math.hypot(m[0], m[1], m[2]) : 0;
      if (m && mn > 0) {
        const mx = m[0] / mn, my = m[1] / mn, mz = m[2] / mn;
        const hx = mx * (q0*q0 + q1*q1 - q2*q2 - q3*q3) + 2*my*(q1*q2 - q0*q3) + 2*mz*(q1*q3 + q0*q2);
        const hy = 2*mx*(q1*q2 + q0*q3) + my*(q0*q0 - q1*q1 + q2*q2 - q3*q3) + 2*mz*(q2*q3 - q0*q1);
        const bx = Math.hypot(hx, hy);
        const bz = 2*mx*(q1*q3 - q0*q2) + 2*my*(q2*q3 + q0*q1) + mz*(q0*q0 - q1*q1 - q2*q2 + q3*q3);
        const f1 = 2*(q1*q3 - q0*q2) - ax, f2 = 2*(q0*q1 + q2*q3) - ay, f3 = 1 - 2*(q1*q1 + q2*q2) - az;
        const f4 = 2*bx*(0.5 - q2*q2 - q3*q3) + 2*bz*(q1*q3 - q0*q2) - mx;
        const f5 = 2*bx*(q1*q2 - q0*q3) + 2*bz*(q0*q1 + q2*q3) - my;
        const f6 = 2*bx*(q0*q2 + q1*q3) + 2*bz*(0.5 - q1*q1 - q2*q2) - mz;
        s0 = -2*q2*f1 + 2*q1*f2 - 2*bz*q2*f4 + (-2*bx*q3 + 2*bz*q1)*f5 + 2*bx*q2*f6;
        s1 = 2*q3*f1 + 2*q0*f2 - 4*q1*f3 + 2*bz*q3*f4 + (2*bx*q2 + 2*bz*q0)*f5 + (2*bx*q3 - 4*bz*q1)*f6;
        s2 = -2*q0*f1 + 2*q3*f2 - 4*q2*f3 + (-4*bx*q2 - 2*bz*q0)*f4 + (2*bx*q1 + 2*bz*q3)*f5 + (2*bx*q0 - 4*bz*q2)*f6;
        s3 = 2*q1*f1 + 2*q2*f2 + (-4*bx*q3 + 2*bz*q1)*f4 + (-2*bx*q0 + 2*bz*q2)*f5 + 2*bx*q1*f6;
      } else {
        const f1 = 2*(q1*q3 - q0*q2) - ax, f2 = 2*(q0*q1 + q2*q3) - ay, f3 = 1 - 2*(q1*q1 + q2*q2) - az;
        s0 = -2*q2*f1 + 2*q1*f2;
        s1 = 2*q3*f1 + 2*q0*f2 - 4*q1*f3;
        s2 = -2*q0*f1 + 2*q3*f2 - 4*q2*f3;
        s3 = 2*q1*f1 + 2*q2*f2;
      }
      const sn = Math.hypot(s0, s1, s2, s3);
      if (sn > 0) {
        qd0 -= this.beta * s0 / sn; qd1 -= this.beta * s1 / sn;
        qd2 -= this.beta * s2 / sn; qd3 -= this.beta * s3 / sn;
      }
    }
    q0 += qd0 * dt; q1 += qd1 * dt; q2 += qd2 * dt; q3 += qd3 * dt;
    const n = Math.hypot(q0, q1, q2, q3);
    this.q = [q0 / n, q1 / n, q2 / n, q3 / n];
  }

  /** roll, pitch, yaw in degrees (ZYX). */
  euler(): [number, number, number] {
    const [w, x, y, z] = this.q, d = 180 / Math.PI;
    const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
    const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x))));
    const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
    return [roll * d, pitch * d, yaw * d];
  }
}
