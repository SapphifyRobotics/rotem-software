// ROTEM USB line protocol, protocol/wire-0.6.md. Pure parsing, no I/O.

/** Full scale of the stream, from the board's CFG line; raw = value * 32768 / full scale. */
export interface Scale {
  accelFsG: number;
  gyroFsDps: number;
}
export const DEFAULT_SCALE: Scale = { accelFsG: 4, gyroFsDps: 500 };
export const MAG_LSB_PER_GAUSS = 16384; // MMC5983MA 18-bit, offset removed in firmware
export const tempC = (raw: number) => raw / 128 + 25;

export interface Sample {
  t: number; // board ms
  n: number; // sequence
  accel: [number, number, number]; // g
  gyro: [number, number, number]; // deg/s
  mag: [number, number, number]; // gauss
  magSeq: number;
  tempC: number;
  imuErrors: number;
  magErrors: number;
  magCode: number; // last magnetometer error code, 0 none
  /** On-board fusion (firmware 0.6.0+): quaternion [w,x,y,z], yaw/pitch/roll and continuous yaw in degrees,
   *  learned gyro bias in deg/s, flags (1 still, 2 calibrated, 4 magnetometer in use, 8 sensor error, 16 USB). */
  board?: {
    q: number[];
    ypr: number[];
    yawCont: number;
    bias: number[];
    flags: number;
  };
}

const triple = (s: string, scale: number): [number, number, number] => {
  const p = s.split(",").map(Number);
  return [p[0] / scale, p[1] / scale, p[2] / scale];
};

/** key=value fields of a reply line, after its first word(s). */
export function fields(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tok of line.split(" ")) {
    const i = tok.indexOf("=");
    if (i > 0) out[tok.slice(0, i)] = tok.slice(i + 1);
  }
  return out;
}

export function parseSample(
  line: string,
  scale: Scale = DEFAULT_SCALE,
): Sample | null {
  if (!line.startsWith("S ")) return null;
  const f = fields(line);
  const vector = (v: string | undefined, length: number) =>
    !!v &&
    v.split(",").length === length &&
    v.split(",").every((n) => n.trim() !== "" && Number.isFinite(Number(n)));
  const scalar = (v: string | undefined) =>
    v !== undefined && v.trim() !== "" && Number.isFinite(Number(v));
  if (
    ![f.a, f.g, f.m].every((v) => vector(v, 3)) ||
    ![f.t, f.n, f.mn, f.temp, f.ie, f.me].every(scalar)
  )
    return null;
  if (
    !(scale.accelFsG > 0 && scale.gyroFsDps > 0) ||
    !Number.isFinite(scale.accelFsG + scale.gyroFsDps)
  )
    return null;
  if (
    f.q &&
    (!vector(f.q, 4) ||
      !vector(f.ypr, 3) ||
      !vector(f.fb, 3) ||
      !scalar(f.cy) ||
      !scalar(f.fl))
  )
    return null;
  return {
    t: Number(f.t),
    n: Number(f.n),
    accel: triple(f.a, 32768 / scale.accelFsG),
    gyro: triple(f.g, 32768 / scale.gyroFsDps),
    mag: triple(f.m, MAG_LSB_PER_GAUSS),
    magSeq: Number(f.mn),
    tempC: tempC(Number(f.temp)),
    imuErrors: Number(f.ie),
    magErrors: Number(f.me),
    magCode: Number(f.mc ?? 0),
    board: f.q
      ? {
          q: f.q.split(",").map((v) => Number(v) / 10000),
          ypr: (f.ypr ?? "0,0,0").split(",").map((v) => Number(v) / 100),
          yawCont: Number(f.cy ?? 0) / 100,
          bias: (f.fb ?? "0,0,0").split(",").map((v) => Number(v) / 1000),
          flags: Number(f.fl ?? 0),
        }
      : undefined,
  };
}

export interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}
export function parseTest(line: string): TestResult | null {
  const m = /^TEST (\S+) (PASS|FAIL)(.*)$/.exec(line);
  return m ? { name: m[1], pass: m[2] === "PASS", detail: m[3].trim() } : null;
}

/** Board settings, as the CFG line reports them (firmware 0.2.0 and later). */
export interface DeviceConfig {
  accel_fs_g: number;
  gyro_fs_dps: number;
  odr_hz: number;
  rate_hz: number;
  mag: number;
  mag_hz: number;
  led: number;
  ma: number;
  gb: number[];
  mo: number[];
  ms: number[];
  saved: number;
}
export function parseConfig(line: string): DeviceConfig | null {
  if (!line.startsWith("CFG ")) return null;
  const f = fields(line);
  const t = (s: string | undefined) => (s ?? "0,0,0").split(",").map(Number);
  return {
    accel_fs_g: +f.accel_fs_g,
    gyro_fs_dps: +f.gyro_fs_dps,
    odr_hz: +f.odr_hz,
    rate_hz: +f.rate_hz,
    mag: +f.mag,
    mag_hz: +f.mag_hz,
    led: +f.led,
    ma: +(f.ma ?? 0),
    gb: t(f.gb),
    mo: t(f.mo),
    ms: t(f.ms),
    saved: +f.saved,
  };
}
