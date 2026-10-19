// Replays a recorded ROTEM stream (04_verification/static-audit/record.mjs) through the app's filters.
//   AUDIT_FILE=../../04_verification/static-audit/static-600s.jsonl npx vitest run test/replay.test.ts
import { describe, it } from 'vitest';
import fs from 'node:fs';
import { AttitudeEkf, EKF_DEFAULTS } from '../src/ekf';

const file = process.env.AUDIT_FILE;
const D2R = Math.PI / 180;

describe.skipIf(!file)('replay', () => {
  it('reports yaw drift and tilt stability of the filters on a stationary recording', () => {
    // Read in chunks: an overnight file is larger than the biggest string JavaScript allows.
    const lines: any[] = [];
    { const fd = fs.openSync(file!, 'r'), buf = Buffer.alloc(1 << 24); let rest = '', n: number;
      while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
        const parts = (rest + buf.toString('utf8', 0, n)).split('\n'); rest = parts.pop()!;
        for (const l of parts) if (l) lines.push(JSON.parse(l));
      }
      if (rest) lines.push(JSON.parse(rest)); fs.closeSync(fd); }
    const cfgLine: string = lines.find((r) => r.meta?.startsWith('CFG'))?.meta ?? '';
    const fsA = +(cfgLine.match(/accel_fs_g=(\d+)/)?.[1] ?? 4), fsG = +(cfgLine.match(/gyro_fs_dps=(\d+)/)?.[1] ?? 500);
    const rows = lines.filter((r) => r.t !== undefined);
    const run = (zeroRate: boolean, holdStill = true) => {
      const f = new AttitudeEkf({ ...EKF_DEFAULTS, zeroRate, holdStill });
      let prev = rows[0].t, still = 0, yaw0: number | null = null;
      const yaws: number[] = [], rolls: number[] = [], pitches: number[] = [];
      const trace: string[] = ['t_s,roll_deg,pitch_deg,yaw_deg,bias_x_dps,bias_y_dps,bias_z_dps,still'];
      let k = 0;
      for (const r of rows) {
        const dt = Math.min(Math.max((r.t - prev) / 1000, 0.001), 0.1); prev = r.t;
        f.update(r.g.map((v: number) => v * fsG / 32768 * D2R), r.a.map((v: number) => v * fsA / 32768), null, dt);
        if (f.still) still++;
        const [ro, pi, ya] = f.euler();
        if (zeroRate && k++ % 100 === 0) trace.push([((r.t - rows[0].t) / 1000).toFixed(2), ro.toFixed(4), pi.toFixed(4), ya.toFixed(4), ...f.bias.map((b) => (b / D2R).toFixed(5)), f.still ? 1 : 0].join(','));
        if ((r.t - rows[0].t) / 1000 >= 30) { // after a 30 s settle, as a robot would wait after boot
          if (yaw0 === null) yaw0 = ya;
          yaws.push(ya - yaw0); rolls.push(ro); pitches.push(pi);
        }
      }
      if (zeroRate) fs.writeFileSync(file!.replace(/\.jsonl$/, '-kalman-trace.csv'), trace.join('\n') + '\n');
      const hours = (rows[rows.length - 1].t - rows[0].t - 30000) / 3.6e6;
      // Loops, not Math.max(...x): an overnight run has over a million samples, too many for spread arguments.
      const max = (x: number[]) => { let m = -Infinity; for (const v of x) if (v > m) m = v; return m; };
      const min = (x: number[]) => { let m = Infinity; for (const v of x) if (v < m) m = v; return m; };
      const ptp = (x: number[]) => max(x) - min(x);
      // Robust spread: 1st to 99th percentile, so a single tap on the table does not define it.
      const p98 = (x: number[]) => { const s = [...x].sort((a, b) => a - b); return s[Math.floor(s.length * 0.99)] - s[Math.floor(s.length * 0.01)]; };
      return {
        zeroRate, holdStill, still_fraction: +(still / rows.length).toFixed(3),
        yaw_final_deg: +yaws[yaws.length - 1].toFixed(4), yaw_max_abs_deg: +max(yaws.map(Math.abs)).toFixed(4),
        yaw_drift_deg_per_hour: +(yaws[yaws.length - 1] / hours).toFixed(4),
        roll_p1_p99_deg: +p98(rolls).toFixed(4), pitch_p1_p99_deg: +p98(pitches).toFixed(4),
        roll_pk_pk_deg: +ptp(rolls).toFixed(4), pitch_pk_pk_deg: +ptp(pitches).toFixed(4),
        yaw_p1_p99_deg: +p98(yaws).toFixed(4),
        bias_dps: f.bias.map((b) => +(b / D2R).toFixed(4)),
      };
    };
    const out = { file, minutes: +((rows[rows.length - 1].t - rows[0].t) / 60000).toFixed(2), with_zero_rate: run(true), zero_rate_no_hold: run(true, false), without: run(false) };
    console.log(JSON.stringify(out, null, 1));
    fs.writeFileSync(file!.replace(/\.jsonl$/, '-replay.json'), JSON.stringify(out, null, 1));
  }, 600000);
});
