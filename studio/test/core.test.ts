import { describe, it, expect } from 'vitest';
import { parseSample, parseTest, parseConfig } from '../src/protocol';
import { Madgwick } from '../src/ahrs';

describe('protocol', () => {
  it('parses a stream line captured from board B', () => {
    const s = parseSample('S t=60630 n=1004 a=-492,810,8188 g=11,-10,1 m=1508,13063,6414 mn=593 temp=544 ie=0 me=0')!;
    expect(s.n).toBe(1004);
    expect(s.accel[2]).toBeCloseTo(0.9995, 3);
    expect(s.gyro[0]).toBeCloseTo(11 * 500 / 32768, 4);
    expect(s.tempC).toBeCloseTo(29.25, 2);
    expect(s.mag[1]).toBeCloseTo(13063 / 16384, 5);
  });
  it('parses test lines', () => {
    expect(parseTest('TEST vdda PASS mv=3298')).toEqual({ name: 'vdda', pass: true, detail: 'mv=3298' });
    expect(parseTest('TEST done')).toBeNull();
  });
});

describe('ahrs', () => {
  it('converges to the tilt gravity gives', () => {
    const f = new Madgwick(0.5);
    const r = 20 * Math.PI / 180; // rolled 20 degrees about x
    for (let i = 0; i < 2000; i++) f.update([0, 0, 0], [0, Math.sin(r), Math.cos(r)], null, 0.01);
    expect(f.euler()[0]).toBeCloseTo(20, 0);
    expect(Math.abs(f.euler()[1])).toBeLessThan(0.5);
  });
  it('integrates yaw rate', () => {
    const f = new Madgwick(0.0);
    for (let i = 0; i < 100; i++) f.update([0, 0, Math.PI / 2], [0, 0, 1], null, 0.01);
    expect(f.euler()[2]).toBeCloseTo(90, 0);
  });
});

import { AttitudeEkf, EKF_DEFAULTS } from '../src/ekf';
describe('ekf', () => {
  it('converges to gravity tilt', () => {
    const f = new AttitudeEkf();
    const r = 20 * Math.PI / 180;
    for (let i = 0; i < 1000; i++) f.update([0, 0, 0], [0, Math.sin(r), Math.cos(r)], null, 0.01);
    expect(f.euler()[0]).toBeCloseTo(20, 0);
  });
  it('estimates a constant gyro bias on roll and pitch axes', () => {
    const f = new AttitudeEkf();
    for (let i = 0; i < 6000; i++) f.update([0.02, -0.01, 0], [0, 0, 1], null, 0.01);
    expect(f.bias[0]).toBeCloseTo(0.02, 2);
    expect(f.bias[1]).toBeCloseTo(-0.01, 2);
    expect(Math.abs(f.euler()[0])).toBeLessThan(1);
  });
  it('integrates yaw rate', () => {
    const f = new AttitudeEkf();
    for (let i = 0; i < 100; i++) f.update([0, 0, Math.PI / 2], [0, 0, 1], null, 0.01);
    expect(f.euler()[2]).toBeCloseTo(90, 0);
  });
});

describe('config', () => {
  it('parses a CFG line and scales by it', () => {
    const c = parseConfig('CFG accel_fs_g=8 gyro_fs_dps=2000 odr_hz=200 rate_hz=100 mag=0 mag_hz=20 led=0 gb=12,-5,3 mo=0,0,0 ms=0,0,0 saved=1')!;
    expect(c.accel_fs_g).toBe(8); expect(c.gb).toEqual([12, -5, 3]); expect(c.saved).toBe(1);
    const s = parseSample('S t=1 n=1 a=0,0,4096 g=16,0,0 m=0,0,0 mn=0 temp=0 ie=0 me=0 mc=0', { accelFsG: 8, gyroFsDps: 2000 })!;
    expect(s.accel[2]).toBeCloseTo(1, 5); expect(s.gyro[0]).toBeCloseTo(16 * 2000 / 32768, 5);
  });
});

import { MAG_AXES, apply, findMagAxes, describe as describeAxes } from '../src/magaxes';
describe('mag axes', () => {
  it('index 0 is the datasheet default (x, y, -z)', () => {
    expect(describeAxes(MAG_AXES[0])).toBe('x=mx y=my z=-mz');
    expect(MAG_AXES.length).toBe(48);
  });
  it('recovers a mapping from a simulated rotation', () => {
    const truth = 13;
    const inv = (m: number[][]) => m[0].map((_, j) => m.map((r) => r[j])); // signed permutation: inverse = transpose
    const fieldWorld = [0.25, 0, -0.35];
    const samples = []; let q = [1, 0, 0, 0];
    const rot = (q: number[], v: number[]) => { // world -> body with body-to-world quaternion q
      const [w, x, y, z] = q; const R = [[1-2*(y*y+z*z),2*(x*y-w*z),2*(x*z+w*y)],[2*(x*y+w*z),1-2*(x*x+z*z),2*(y*z-w*x)],[2*(x*z-w*y),2*(y*z+w*x),1-2*(x*x+y*y)]];
      return [0,1,2].map((c) => R[0][c]*v[0] + R[1][c]*v[1] + R[2][c]*v[2]);
    };
    for (let k = 0; k < 600; k++) {
      const t = k * 0.05, g = [Math.sin(t * 0.7), Math.cos(t * 0.5), 0.8 * Math.sin(t * 0.3 + 1)];
      const mb = rot(q, fieldWorld);
      samples.push({ t, gyro: g, mag: apply(inv(MAG_AXES[truth]), mb), accel: rot(q, [0, 0, 1]) });
      const n = Math.hypot(...g) * 0.05, ax = g.map((v) => v / Math.hypot(...g));
      const d = [Math.cos(n / 2), ...ax.map((v) => v * Math.sin(n / 2))];
      const [a0, a1, a2, a3] = q, [b0, b1, b2, b3] = d;
      q = [a0*b0-a1*b1-a2*b2-a3*b3, a0*b1+a1*b0+a2*b3-a3*b2, a0*b2-a1*b3+a2*b0+a3*b1, a0*b3+a1*b2-a2*b1+a3*b0];
    }
    const r = findMagAxes(samples)!;
    expect(r.index).toBe(truth);
    expect(r.margin).toBeGreaterThan(5);
    expect(r.dip).toBeCloseTo(Math.atan2(0.35, 0.25) * 180 / Math.PI, 0);
  });
});

describe('ekf with magnetometer', () => {
  it('finds absolute heading from a tilted board', () => {
    const f = new AttitudeEkf();
    const yaw = 40 * Math.PI / 180, roll = 15 * Math.PI / 180;
    // body-to-world: yaw about z then roll about x; world x = magnetic north, field dips 45 degrees
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cr = Math.cos(roll), sr = Math.sin(roll);
    const R = [[cy, -sy * cr, sy * sr], [sy, cy * cr, -cy * sr], [0, sr, cr]];
    const toBody = (v: number[]) => [0, 1, 2].map((c) => R[0][c] * v[0] + R[1][c] * v[1] + R[2][c] * v[2]);
    const accel = toBody([0, 0, 1]), mag = toBody([0.3, 0, -0.3]);
    for (let i = 0; i < 3000; i++) f.update([0, 0, 0], accel, mag, 0.01);
    const [r, , y] = f.euler();
    expect(r).toBeCloseTo(15, 0);
    expect(y).toBeCloseTo(40, 0);
  });
});

describe('ekf zero-rate update', () => {
  it('learns the yaw-axis bias while still, so heading stops drifting', () => {
    const f = new AttitudeEkf(); const noBias = new AttitudeEkf({ ...EKF_DEFAULTS, zeroRate: false });
    let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
    const bz = 0.0005; // rad/s (0.029 deg/s), the order seen on the board
    for (let i = 0; i < 60000; i++) { // 10 minutes at 100 Hz
      const g = [0.001 * rnd(), 0.001 * rnd(), bz + 0.001 * rnd()], a = [0.0005 * rnd(), 0.0005 * rnd(), 1];
      f.update(g, a, null, 0.01); noBias.update(g, a, null, 0.01);
    }
    expect(f.bias[2]).toBeCloseTo(bz, 4);
    expect(Math.abs(f.euler()[2])).toBeLessThan(0.5);
    expect(Math.abs(noBias.euler()[2])).toBeGreaterThan(10);
  }, 60000);
});
