import { Commands } from "./commands";
import { HubLink, SerialLink, type Link } from "./link";
import {
  parseSample,
  parseTest,
  parseConfig,
  fields,
  type Sample,
  type Scale,
  type DeviceConfig,
  type TestResult,
  DEFAULT_SCALE,
} from "./protocol";
import { Madgwick } from "./ahrs";
import { AttitudeEkf, EKF_DEFAULTS, type EkfParams } from "./ekf";
import { BoardView } from "./scene";
import { FlatBoardView } from "./flatview";
import { Strip } from "./chart";
import { drawHorizon, drawCompass } from "./instruments";
import { enhanceSelects } from "./select";
import type { ViewMode } from "./scene";
import {
  MAG_AXES,
  apply,
  findMagAxes,
  describe as describeAxes,
  type RotSample,
} from "./magaxes";

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const css = (v: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const D2R = Math.PI / 180;
const MAG_LSB_PER_GAUSS = 16384;
$("appver").textContent = "0.9.0";
enhanceSelects();

// ---------- small guidance helpers: toast and help popovers
let toastTimer = 0;
function toast(msg: string, bad = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (bad ? " bad" : "");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.className = "toast"), 2600);
}
const pop = $("pop");
function showHelp(el: HTMLElement) {
  pop.textContent = el.dataset.help ?? "";
  pop.hidden = false;
  const r = el.getBoundingClientRect();
  pop.style.left = `${Math.min(window.innerWidth - 300, Math.max(8, r.left - 130))}px`;
  pop.style.top = `${r.bottom + 8}px`;
}
document.addEventListener("pointerover", (e) => {
  const h = (e.target as Element).closest<HTMLElement>(".help");
  if (h) showHelp(h);
});
document.addEventListener("pointerout", (e) => {
  if ((e.target as Element).closest(".help")) pop.hidden = true;
});
document.addEventListener(
  "click",
  (e) => {
    const h = (e.target as Element).closest<HTMLElement>(".help");
    if (h) {
      e.preventDefault();
      e.stopPropagation();
      showHelp(h);
      setTimeout(() => (pop.hidden = true), 4000);
    }
  },
  true,
);

// ---------- viewer preferences (this browser only; board settings live on the board)
const prefs = (() => {
  const d = {
    source: "board",
    algo: "ekf",
    useMag: null,
    beta: 0.08,
    ekf: { ...EKF_DEFAULTS },
    tab: "overview",
    mode: "simple",
    view: "board",
  };
  try {
    return {
      ...d,
      ...JSON.parse(localStorage.getItem("rotem-studio") ?? "{}"),
    };
  } catch {
    return d;
  }
})() as {
  source: "board" | "app";
  algo: "ekf" | "madgwick";
  useMag: boolean | null;
  beta: number;
  ekf: EkfParams;
  tab: string;
  mode: "simple" | "advanced";
  view: ViewMode;
};
const savePrefs = () => {
  try {
    localStorage.setItem("rotem-studio", JSON.stringify(prefs));
  } catch {
    /* private mode */
  }
};

// ---------- 3D view, with a 2D fallback when WebGL is off
function makeView(): BoardView | FlatBoardView {
  try {
    return new BoardView($("board"));
  } catch (e) {
    console.warn("WebGL unavailable, 2D view", e);
    $("board").innerHTML = "";
    $("nogl").hidden = false;
    return new FlatBoardView($("board"));
  }
}
const view = makeView();

const madgwick = new Madgwick(prefs.beta);
const ekf = new AttitudeEkf(prefs.ekf);
const colors = [
  css("--x") || "#f05c50",
  css("--y") || "#78cd6e",
  css("--z") || "#7aa7ff",
];
const charts = {
  acc: new Strip($<HTMLCanvasElement>("ch-acc"), 2, colors),
  gyro: new Strip($<HTMLCanvasElement>("ch-gyro"), 250, colors),
  mag: new Strip($<HTMLCanvasElement>("ch-mag"), 1, colors),
};

// ---------- state
let link: Link | null = null;
const commands = new Commands(async (s) => {
  if (!link) throw new Error("Connect a board first");
  await link.send(s);
});
async function verifiedSend(s: string) {
  const reply = await commands.request(s, (line) => line.startsWith("CFG "));
  const f = fields(reply);
  if (s === "SAVE" && f.saved !== "1")
    throw new Error("Board did not confirm persisted settings");
  if (s.startsWith("SET ")) {
    const [key, want] = s.slice(4).split("=");
    if (f[key] !== want) throw new Error(`Readback mismatch for ${key}`);
  }
  return reply;
}

let boardFusion: Sample["board"] | null = null;
/** Show the board's own filter (what a robot gets on CAN) unless the viewer picked the app's filter to compare. */
const useBoard = () => !!boardFusion && prefs.source === "board";
let hubDevice: string | null = null;
let hubBusy = false;
let info: Record<string, string> | null = null;
let cfg: DeviceConfig | null = null;
let cfgSupported = true;
let scale: Scale = DEFAULT_SCALE;
let last: Sample | null = null;
let lost = 0;
let boardTimes: number[] = [];
let magTimes: { t: number; n: number }[] = [];
let lastArrival = 0;
let rails: Record<string, string> | null = null;
let tests: TestResult[] = [];
let gyroCal: { sum: number[]; n: number; until: number } | null = null;
let gyroMeasured: number[] | null = null;
let magCal: {
  min: number[];
  max: number[];
  bins: Set<number>;
  until: number;
  start: number;
} | null = null;
let magResult: { off: number[]; sc: number[]; axes: number } | null = null;
let magSamples: {
  t: number;
  gyro: number[];
  raw: number[];
  accel: number[];
}[] = [];
let lastMagSeq = -1;
let magBoard: number[] | null = null; // latest calibrated field, board frame, gauss
/** The board's magnetometer has been calibrated (offsets and scales stored). */
const magCalibrated = () => !!cfg && cfg.ms.some((v) => v !== 0);
/** Magnetometer in the fusion: the viewer's choice, else on once the board is calibrated. */
const useMagNow = () => (prefs.useMag ?? magCalibrated()) && !!cfg?.mag;

// ---------- console
const logEl = $("log");
function log(s: string) {
  logEl.textContent += s + "\n";
  if (logEl.textContent!.length > 30000)
    logEl.textContent = logEl.textContent!.slice(-20000);
  logEl.scrollTop = logEl.scrollHeight;
}

// ---------- tabs
const TITLES: Record<string, [string, string]> = {
  overview: ["YOUR ROTEM", "Device overview"],
  live: ["RAW SENSORS", "Sensor measurements"],
  device: ["STORED ON THE BOARD", "Board settings"],
  filter: ["SENSOR FUSION", "Sensor fusion"],
  cal: ["CALIBRATION", "Sensor calibration"],
  console: ["LINE PROTOCOL", "Device console"],
  can: ["CLASSIC CAN", "CAN configuration"],
  firmware: ["FIRMWARE", "Firmware & recovery"],
};
function showTab(name: string) {
  if (!TITLES[name]) name = "overview";
  if (
    prefs.mode === "simple" &&
    document.querySelector(`[data-tab=${name}]`)?.classList.contains("adv")
  )
    name = "overview";
  document
    .querySelectorAll<HTMLButtonElement>("[data-tab]")
    .forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  $("eyebrow").textContent = TITLES[name][0];
  $("title").textContent = TITLES[name][1];
  document
    .querySelectorAll(".tab")
    .forEach((t) => t.classList.toggle("on", t.id === "tab-" + name));
  prefs.tab = name;
  savePrefs();
}
document
  .querySelectorAll<HTMLButtonElement>("[data-tab]")
  .forEach((b) => (b.onclick = () => showTab(b.dataset.tab!)));
function setMode(m: "simple" | "advanced") {
  prefs.mode = m;
  savePrefs();
  document.body.classList.toggle("simple", m === "simple");
  document
    .querySelectorAll<HTMLButtonElement>("[data-mode]")
    .forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
  showTab(prefs.tab);
}
document
  .querySelectorAll<HTMLButtonElement>("[data-mode]")
  .forEach(
    (b) => (b.onclick = () => setMode(b.dataset.mode as "simple" | "advanced")),
  );
setMode(prefs.mode);

function setView(v: ViewMode) {
  prefs.view = v;
  savePrefs();
  view.setMode(v);
  document
    .querySelectorAll<HTMLButtonElement>("[data-view]")
    .forEach((b) => b.classList.toggle("on", b.dataset.view === v));
}
document
  .querySelectorAll<HTMLButtonElement>("[data-view]")
  .forEach((b) => (b.onclick = () => setView(b.dataset.view as ViewMode)));
setView(prefs.view);

// ---------- incoming
function onLine(line: string) {
  commands.accept(line);
  if (line.startsWith("CAN ")) $("can-result").textContent = line;
  const s = parseSample(line, scale);
  if (s) return onSample(s);
  log("< " + line);
  const t = parseTest(line);
  if (t) {
    if (t.name === "imu_id") tests = [];
    tests.push(t);
    return renderTests();
  }
  const c = parseConfig(line);
  if (c) {
    const f = fields(line);
    if (f.can_node) $<HTMLInputElement>("can-node").value = f.can_node;
    if (f.can_kbps) {
      $<HTMLInputElement>("can-kbps").value = f.can_kbps;
      document
        .querySelectorAll<HTMLElement>("[data-can-rate]")
        .forEach((b) =>
          b.setAttribute(
            "aria-pressed",
            String(b.dataset.canRate === f.can_kbps),
          ),
        );
    }
  }
  if (c) {
    cfg = c;
    scale = { accelFsG: c.accel_fs_g, gyroFsDps: c.gyro_fs_dps };
    cfgSupported = true;
    renderFusion();
    renderWizards();
    return renderConfig();
  }
  if (line === "OK saved") return; // CFG readback confirms persisted state
  if (line.startsWith("ERR"))
    toast(line.replace(/^ERR /, "The board said: "), true);
  if (line.startsWith("INFO ")) {
    info = fields(line);
    return renderInfo();
  }
  if (line.startsWith("RAILS ")) {
    rails = fields(line);
    rails.ok = String(line.startsWith("RAILS OK"));
    return;
  }
  if (line.startsWith("HUB ")) {
    const f = fields(line);
    const was = hubDevice;
    hubDevice = f.device === "none" ? null : f.device;
    hubBusy = f.busy === "1";
    if (hubDevice && hubDevice !== was) void handshake();
    return renderDevice();
  }
  if (line.startsWith("ERR commands:") && !cfg) {
    cfgSupported = false;
    renderConfig();
  }
}

function onSample(s: Sample) {
  const now = performance.now();
  if (last && s.n > last.n + 1) lost += s.n - last.n - 1;
  if (last && s.n < last.n) {
    lost = 0;
    boardTimes = [];
    magTimes = [];
  } // stream restarted
  const dt =
    last && s.n > last.n
      ? Math.min(Math.max((s.t - last.t) / 1000, 0.001), 0.1)
      : 0.01;
  last = s;
  lastArrival = now;
  boardTimes.push(s.t);
  while (boardTimes[0] < s.t - 2000) boardTimes.shift();
  magTimes.push({ t: s.t, n: s.magSeq });
  while (magTimes[0].t < s.t - 2000) magTimes.shift();

  const gb = cfg ? cfg.gb.map((v) => v / 1000) : [0, 0, 0];
  const gyro = s.gyro.map((v, i) => v - gb[i]);
  // Magnetometer: raw counts -> hard/soft-iron correction (sensor frame) -> board frame.
  const magCounts = s.mag.map((v) => v * MAG_LSB_PER_GAUSS);
  const magSensor = cfg
    ? magCounts.map(
        (v, i) =>
          ((v - cfg!.mo[i]) * (cfg!.ms[i] ? cfg!.ms[i] / 1e6 : 1)) /
          MAG_LSB_PER_GAUSS,
      )
    : s.mag;
  const mag = apply(MAG_AXES[cfg?.ma ?? 0], magSensor);
  const newMag = s.magSeq > 0 && s.magSeq !== lastMagSeq;
  lastMagSeq = s.magSeq;
  if (newMag) magBoard = mag;

  if (gyroCal) {
    for (let i = 0; i < 3; i++) gyroCal.sum[i] += s.gyro[i];
    gyroCal.n++;
    if (now > gyroCal.until) finishGyroCal();
  }
  if (magCal && newMag)
    feedMagCal(
      magCounts,
      gyro.map((v) => v * D2R),
      s.accel,
      s.t / 1000,
      now,
    );

  const magOn = useMagNow() && s.magSeq > 0;
  const g = gyro.map((v) => v * D2R);
  if (prefs.algo === "ekf") ekf.update(g, s.accel, magOn ? mag : null, dt);
  else madgwick.update(g, s.accel, magOn ? mag : null, dt);
  const previousFusionMode = boardFusion ? boardFusion.flags & 4 : null;
  boardFusion = s.board ?? null;
  if (previousFusionMode !== (boardFusion ? boardFusion.flags & 4 : null)) renderFusion();
  view.setOrientation(
    useBoard() ? boardFusion!.q : prefs.algo === "ekf" ? ekf.q : madgwick.q,
  );

  charts.acc.push(s.accel);
  charts.gyro.push(gyro);
  charts.mag.push(mag);
}

// ---------- rendering, decoupled from the sample rate
const f3 = (v: number, d: number) => (v >= 0 ? " " : "") + v.toFixed(d);
function frame() {
  const filt = prefs.algo === "ekf" ? ekf : madgwick;
  const eul = (): [number, number, number] =>
    useBoard()
      ? [boardFusion!.ypr[2], boardFusion!.ypr[1], boardFusion!.ypr[0]]
      : filt.euler();
  if (last) {
    const [r, p, y] = eul();
    $("roll").textContent = f3(r, 1) + "°";
    $("pitch").textContent = f3(p, 1) + "°";
    // With the magnetometer, world +x is magnetic north and yaw is the board's x axis from it,
    // counter-clockwise; shown as the compass bearing of the USB edge (board +y), clockwise.
    const hdg = useMagNow() ? 270 - y : y;
    $("yaw").textContent = (((hdg % 360) + 360) % 360).toFixed(1) + "°";
    if (useBoard()) {
      const fl = boardFusion!.flags;
      $("sroll").textContent = $("spitch").textContent =
        fl & 2 ? "on board · calibrated" : "on board · learning, keep still";
      $("syaw").textContent =
        `continuous ${boardFusion!.yawCont.toFixed(1)}°${fl & 1 ? " · still" : ""}`;
    } else if (prefs.algo === "ekf") {
      const sg = ekf.sigmaDeg();
      $("sroll").textContent = `±${sg[0].toFixed(2)}°`;
      $("spitch").textContent = `±${sg[1].toFixed(2)}°`;
      $("syaw").textContent = useMagNow()
        ? `±${sg[2].toFixed(1)}° · magnetic north`
        : "relative, drifts slowly";
    } else {
      $("sroll").textContent = $("spitch").textContent = "";
      $("syaw").textContent = useMagNow()
        ? "magnetic north"
        : "relative, drifts slowly";
    }
    drawHorizon($<HTMLCanvasElement>("horizon"), r, p);
    drawCompass($<HTMLCanvasElement>("compass"), useMagNow() ? 270 - y : y);
    if (prefs.tab === "live") {
      charts.acc.draw();
      charts.gyro.draw();
      charts.mag.draw();
      const gb = cfg ? cfg.gb.map((v) => v / 1000) : [0, 0, 0];
      ["x", "y", "z"].forEach((a, i) => {
        $("a" + a).textContent = last!.accel[i].toFixed(3);
        $("g" + a).textContent = (last!.gyro[i] - gb[i]).toFixed(2);
        $("m" + a).textContent = last!.mag[i].toFixed(3);
      });
    }
    $("stillchip").hidden = !(prefs.algo === "ekf" && ekf.still);
    if (prefs.tab === "filter" && prefs.algo === "ekf") {
      $("k-bias-est").textContent =
        ekf.bias.map((b) => (b / D2R).toFixed(3)).join(", ") + " °/s";
      $("k-sigma").textContent =
        ekf
          .sigmaDeg()
          .map((v) => v.toFixed(2))
          .join(", ") + " °";
    }
  } else {
    $("stillchip").hidden = true;
    drawHorizon($<HTMLCanvasElement>("horizon"), 0, 0);
    drawCompass($<HTMLCanvasElement>("compass"), 0);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
setInterval(renderHealth, 500);
setInterval(() => {
  if (link && boardPresent()) void link.send("RAILS");
}, 5000);

function boardPresent() {
  return !!link && (link.kind === "serial" || !!hubDevice);
}
const rate = () =>
  boardTimes.length > 1
    ? ((boardTimes.length - 1) * 1000) /
      (boardTimes[boardTimes.length - 1] - boardTimes[0])
    : 0;
const magRate = () =>
  magTimes.length > 1
    ? ((magTimes[magTimes.length - 1].n - magTimes[0].n) * 1000) /
      (magTimes[magTimes.length - 1].t - magTimes[0].t)
    : 0;

type Check = {
  label: string;
  value: string;
  state: "pass" | "fail" | "warn" | "idle";
};
const WHY: Record<string, [string, string]> = {
  "Data stream": [
    "Readings are arriving from the board right now.",
    "If it stops: check the USB cable, or unplug and plug it back in.",
  ],
  "Sample rate": [
    "How many readings per second arrive, against what the board was asked for.",
    "Too low usually means a busy computer or a poor USB cable or hub.",
  ],
  "Lost samples": [
    "Readings that never arrived. A few after plugging in are harmless.",
    "Many lost readings: try another USB port or a shorter cable.",
  ],
  "Inertial sensor": [
    "The motion sensor (accelerometer and gyroscope) answers without errors.",
    "Errors here point to a hardware fault: note the board and contact support.",
  ],
  Magnetometer: [
    "The compass sensor answers and measures at the rate set.",
    "Errors here point to a hardware fault. You can switch it off in Board settings.",
  ],
  "Magnetic field": [
    "The strength of the field the compass sees. Earth gives about 0.25–0.65 gauss.",
    "Too strong or not calibrated: move away from laptops, magnets and steel, then run step 2 of Calibration.",
  ],
  "Power rails": [
    "The board's 3.3 V and 5 V supplies are inside their limits.",
    "Out of limits: try another USB port or power supply.",
  ],
  "Power input": [
    "Where the board takes its power from: the robot connector (6–28 V) wins over USB when both are present.",
    "Robot voltage outside 6–28 V: check the supply and the connector.",
  ],
  "Sensor temperature": [
    "Inside the motion sensor.",
    "Outside −20…85 °C the readings are not specified.",
  ],
  "Board self-test": [
    "The board checks its own sensors and power when it connects.",
    'Press "Check again". A test that keeps failing points to a hardware fault.',
  ],
};
const openChecks = new Set<string>();
function checks(): Check[] {
  const out: Check[] = [];
  const stale = !last || performance.now() - lastArrival > 2000;
  out.push({
    label: "Data stream",
    value: stale ? "no data" : "live",
    state: stale ? "fail" : "pass",
  });
  const want = cfg?.rate_hz ?? 100,
    r = rate();
  out.push({
    label: "Sample rate",
    value: `${r.toFixed(1)} / ${want} Hz`,
    state: stale ? "idle" : r > want * 0.9 ? "pass" : "fail",
  });
  out.push({
    label: "Lost samples",
    value: String(lost),
    state: lost ? "warn" : "pass",
  });
  out.push({
    label: "Inertial sensor",
    value: last ? `${last.imuErrors} errors` : "–",
    state: !last ? "idle" : last.imuErrors ? "fail" : "pass",
  });
  if (cfg && !cfg.mag)
    out.push({ label: "Magnetometer", value: "disabled", state: "idle" });
  else {
    const mr = magRate();
    out.push({
      label: "Magnetometer",
      value: last
        ? `${mr.toFixed(0)} Hz, ${last.magErrors} errors${last.magErrors ? ` (code ${last.magCode})` : ""}`
        : "–",
      state: !last
        ? "idle"
        : last.magErrors
          ? "fail"
          : mr > (cfg?.mag_hz ?? 20) * 0.7
            ? "pass"
            : "warn",
    });
  }
  if (cfg?.mag && magBoard) {
    const f = Math.hypot(...magBoard);
    out.push({
      label: "Magnetic field",
      value: `${f.toFixed(2)} G${magCalibrated() ? "" : " · not calibrated"}`,
      state: !magCalibrated() ? "warn" : f > 0.2 && f < 0.7 ? "pass" : "warn",
    });
  }
  if (rails) {
    const v3 = +rails.vdda_mv,
      v5 = +rails.rail5_mv;
    out.push({
      label: "Power rails",
      value: `${(v3 / 1000).toFixed(2)} V · ${(v5 / 1000).toFixed(2)} V`,
      state:
        rails.ok === "true" && v3 > 3100 && v3 < 3500 && v5 > 4500 && v5 < 5500
          ? "pass"
          : "fail",
    });
  }
  if (rails && rails.vin_mv !== undefined) {
    const vin = +rails.vin_mv / 1000,
      usb = rails.usb === "1";
    out.push({
      label: "Power input",
      value:
        vin > 5.5
          ? `robot ${vin.toFixed(1)} V${usb ? " + USB" : ""}`
          : usb
            ? "USB"
            : "unknown",
      state: vin > 5.5 && (vin < 6 || vin > 28) ? "fail" : "pass",
    });
  }
  if (last)
    out.push({
      label: "Sensor temperature",
      value: `${last.tempC.toFixed(1)} °C`,
      state: last.tempC > -20 && last.tempC < 85 ? "pass" : "fail",
    });
  return out;
}
const icon = (s: string) => (s === "pass" ? "✓" : s === "idle" ? "·" : "!");
function renderHealth() {
  const pill = $("health");
  if (!link) {
    pill.textContent = "Offline";
    pill.className = "pill";
    $("checks").innerHTML = "";
    statusbar();
    renderGuide([]);
    return;
  }
  if (!boardPresent()) {
    pill.textContent = "Waiting for board";
    pill.className = "pill warn";
    $("checks").innerHTML = "";
    statusbar();
    renderGuide([]);
    return;
  }
  const list = checks();
  if (tests.length) {
    const failed = tests.filter((t) => !t.pass);
    list.push({
      label: "Board self-test",
      value: failed.length
        ? `${failed.length} of ${tests.length} failed`
        : `${tests.length} of ${tests.length} passed`,
      state: failed.length ? "fail" : "pass",
    });
  }
  $("checks").innerHTML = list
    .map((c) => {
      const [what, fix] = WHY[c.label] ?? ["", ""];
      const extra =
        c.label === "Board self-test"
          ? "<br>" +
            tests
              .map(
                (t) => `${t.pass ? "✓" : "✗"} ${TEST_NAMES[t.name] ?? t.name}`,
              )
              .join(" · ")
          : "";
      return `<li class="${c.state}${openChecks.has(c.label) ? " open" : ""}" data-label="${c.label}"><span class="ic">${icon(c.state)}</span><span>${c.label}</span><span class="val">${c.value}</span><span class="why">${what}${c.state === "fail" || c.state === "warn" ? ` <b>${fix}</b>` : ""}${extra}</span></li>`;
    })
    .join("");
  renderGuide(list);
  const bad = list.filter((c) => c.state === "fail").length;
  const warn = list.filter((c) => c.state === "warn").length;
  pill.textContent = bad
    ? `${bad} problem${bad > 1 ? "s" : ""}`
    : warn
      ? "Check warnings"
      : "All checks pass";
  pill.className = "pill " + (bad ? "bad" : warn ? "warn" : "ok");
  statusbar();
}
function statusbar() {
  $("sb-rate").textContent = last ? `${rate().toFixed(0)} Hz` : "–";
  $("sb-lost").textContent = last ? `${lost} lost ·` : "";
  $("sb-temp").textContent = last ? `${last.tempC.toFixed(1)} °C ·` : "";
  $("sb-up").textContent = last ? `up ${(last.t / 1000).toFixed(0)} s` : "";
}

const TEST_NAMES: Record<string, string> = {
  imu_id: "Inertial sensor identity",
  imu_config: "Inertial sensor configuration",
  accel_1g: "Gravity reads 1 g",
  imu_temp: "Temperature in range",
  mag_id: "Magnetometer identity",
  vdda: "3.3 V rail",
  rail5: "5 V rail",
};
function renderTests() {
  $("tests").innerHTML =
    tests
      .map(
        (t) =>
          `<li class="${t.pass ? "pass" : "fail"}"><span class="ic">${t.pass ? "✓" : "!"}</span><span>${TEST_NAMES[t.name] ?? t.name}</span><span class="val">${t.detail}</span></li>`,
      )
      .join("") || '<li class="muted">Runs automatically on connect.</li>';
}

function renderDevice() {
  const on = boardPresent();
  document.body.classList.toggle("connected", on);
  $("linkdot").className = "dot" + (on ? " on" : "");
  $("devname").textContent = on
    ? "ROTEM" + (info ? ` · ${info.board}` : "")
    : link
      ? "Waiting for board…"
      : "No device";
  $("devsub").textContent = on
    ? `${info ? `fw ${info.fw} · ${info.uid.slice(-8)}` : "…"} · ${link!.kind === "hub" ? "shared via hub" : "this browser only"}`
    : link?.kind === "hub"
      ? hubBusy
        ? "The board is held by another program or tab. Close it there."
        : "Hub running, plug in the board"
      : "Connect a ROTEM over USB";
  const b = $<HTMLButtonElement>("connect");
  b.textContent = link ? "Disconnect" : "Connect";
  b.hidden = link?.kind === "hub";
  b.className = link ? "cta" : "cta accent";
}

function renderInfo() {
  if (!info) return;
  const rows: [string, string][] = [
    ["Firmware", info.fw],
    ["Board revision", info.board],
    ["Unique ID", info.uid],
    ["Inertial sensor", `${info.imu} · id 0x${info.imu_id}`],
    ["Magnetometer", `${info.mag} · id 0x${info.mag_id}`],
    ["Uptime at connect", `${(+info.uptime_ms / 1000).toFixed(0)} s`],
  ];
  $("info").innerHTML = rows
    .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`)
    .join("");
  renderDevice();
}

// ---------- the guide: one sentence on the state, and the next step
$("checks").addEventListener("click", (e) => {
  const li = (e.target as Element).closest<HTMLElement>("li[data-label]");
  if (!li) return;
  const l = li.dataset.label!;
  openChecks.has(l) ? openChecks.delete(l) : openChecks.add(l);
  li.classList.toggle("open");
});
const STEP_HELP: Record<string, [string, string]> = {
  gyro: [
    "Almost ready: teach it to sit still",
    "Calibration step 1 takes three seconds and makes the angles steadier.",
  ],
  mag: [
    "Almost ready: point it at north",
    "Calibration step 2 takes thirty seconds and turns heading into a real compass.",
  ],
};
function stepsDone() {
  const failing =
    checks().some((c) => c.state === "fail") || tests.some((t) => !t.pass);
  return {
    connect: boardPresent(),
    health: boardPresent() && !!last && tests.length > 0 && !failing,
    gyro: !!cfg && cfg.gb.some((v) => v !== 0),
    mag: magCalibrated() || (!!cfg && !cfg.mag),
  } as Record<string, boolean>;
}
function renderGuide(list: Check[]) {
  const done = stepsDone();
  const order = ["connect", "health", "gyro", "mag"];
  const next = order.find((k) => !done[k]);
  document.querySelectorAll<HTMLElement>("#steps li").forEach((li) => {
    const k = li.dataset.step!;
    li.classList.toggle("done", done[k]);
    li.classList.toggle("next", k === next);
  });
  $("setup-count").textContent =
    `${order.filter((k) => done[k]).length} of ${order.length}`;
  const hero = $("hero"),
    title = $("hero-title"),
    sub = $("hero-sub"),
    ic = $("hero-ic");
  const set = (cls: string, i: string, t: string, s2: string) => {
    hero.className = "hero " + cls;
    ic.textContent = i;
    title.textContent = t;
    sub.textContent = s2;
  };
  const fail = list.find((c) => c.state === "fail");
  if (!link)
    set(
      "",
      "·",
      "Plug in your ROTEM",
      "Connect with a USB-C data cable, then choose Connect.",
    );
  else if (!boardPresent())
    set(
      "warn",
      "!",
      hubBusy ? "Another program is using the board" : "Waiting for the board",
      hubBusy
        ? "Close the other tab or app that has it open; it connects here by itself."
        : "Plug in the USB-C cable.",
    );
  else if (!last) set("", "…", "Connecting…", "Reading the board.");
  else if (fail)
    set(
      "bad",
      "!",
      `Needs attention: ${fail.label.toLowerCase()}`,
      (WHY[fail.label] ?? ["", "Tap it below for details."])[1],
    );
  else if (next && STEP_HELP[next])
    set(
      "warn",
      String(order.indexOf(next) + 1),
      STEP_HELP[next][0],
      STEP_HELP[next][1],
    );
  else {
    const filt = prefs.algo === "ekf" ? ekf : madgwick;
    const [r0, p0] = filt.euler();
    set(
      "ok",
      "✓",
      "Everything looks good",
      `Tilted ${Math.hypot(r0, p0).toFixed(1)}° from level${useMagNow() ? ", heading locked to magnetic north" : ""}. Move the board and watch it follow.`,
    );
  }
}
document.querySelectorAll<HTMLButtonElement>("[data-go]").forEach(
  (b) =>
    (b.onclick = () => {
      showTab("cal");
      const wiz = $(b.dataset.go === "cal-mag" ? "wiz-mag" : "wiz-gyro");
      wiz.scrollIntoView({ behavior: "smooth", block: "start" });
      wiz.animate(
        [
          { boxShadow: "0 0 0 3px var(--accent)" },
          { boxShadow: "0 0 0 0 transparent" },
        ],
        { duration: 1200 },
      );
    }),
);

// ---------- presets (simple mode)
const PRESETS: Record<string, Record<string, number>> = {
  balanced: { accel_fs_g: 4, gyro_fs_dps: 500, odr_hz: 100, rate_hz: 100 },
  robot: { accel_fs_g: 16, gyro_fs_dps: 2000, odr_hz: 200, rate_hz: 100 },
  precise: { accel_fs_g: 2, gyro_fs_dps: 250, odr_hz: 100, rate_hz: 100 },
};
function renderPresets() {
  const hit =
    cfg &&
    Object.entries(PRESETS).find(([, v]) =>
      Object.entries(v).every(
        ([k, x]) => (cfg as unknown as Record<string, number>)[k] === x,
      ),
    )?.[0];
  document
    .querySelectorAll<HTMLElement>("[data-preset]")
    .forEach((b) => b.classList.toggle("on", b.dataset.preset === hit));
}
document.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach(
  (b) =>
    (b.onclick = async () => {
      if (!link || !cfg) return;
      try {
        const v = PRESETS[b.dataset.preset!];
        const order =
          v.odr_hz >= cfg.odr_hz
            ? ["odr_hz", "rate_hz"]
            : ["rate_hz", "odr_hz"];
        for (const k of [...order, "accel_fs_g", "gyro_fs_dps"])
          await verifiedSend(`SET ${k}=${v[k]}`);
        toast(`${b.querySelector("b")!.textContent} applied. Save to keep it.`);
      } catch (e) {
        toast(String(e), true);
      }
    }),
);

// ---------- calibration wizards
function renderWizards() {
  const d = stepsDone();
  $("wiz-gyro").classList.toggle("done", d.gyro);
  $("gyro-state").textContent = d.gyro ? "Done ✓" : "";
  $("wiz-mag").classList.toggle("done", magCalibrated());
  $("mag-state").textContent = magCalibrated() ? "Done ✓" : "";
}
const grid = $("cal-mag-grid");
grid.innerHTML = "<i></i>".repeat(32);
function paintGrid(bins: Set<number>) {
  grid.querySelectorAll("i").forEach((cell, k) => {
    const el = Math.floor(k / 8),
      az = k % 8;
    cell.classList.toggle("on", bins.has(az * 4 + (3 - el)));
  });
}

// ---------- device settings form
const form = $<HTMLFormElement>("cfgform");
const fieldNames = [
  "accel_fs_g",
  "gyro_fs_dps",
  "odr_hz",
  "rate_hz",
  "mag",
  "mag_hz",
] as const;
function formValues() {
  const v: Record<string, number> = {};
  for (const n of fieldNames) {
    const el = form.elements.namedItem(n) as
      | HTMLInputElement
      | HTMLSelectElement;
    v[n] =
      el instanceof HTMLInputElement && el.type === "checkbox"
        ? el.checked
          ? 1
          : 0
        : Number(el.value);
  }
  let led = 0;
  form.querySelectorAll<HTMLInputElement>("[data-led]").forEach((c) => {
    if (c.checked) led |= 1 << Number(c.dataset.led);
  });
  v.led = led;
  return v;
}
function renderConfig() {
  const banner = $("cfgstate");
  const controls = form.querySelectorAll<
    HTMLInputElement | HTMLSelectElement | HTMLButtonElement
  >("select, input, button");
  if (!cfgSupported) {
    banner.textContent =
      "This firmware has no stored settings. Update the board to firmware 0.2.0.";
    banner.className = "banner warn";
    controls.forEach((c) => (c.disabled = true));
    return;
  }
  if (!cfg) {
    controls.forEach((c) => (c.disabled = true));
    banner.textContent = "Read from the board on connect.";
    banner.className = "banner";
    return;
  }
  controls.forEach((c) => (c.disabled = false));
  for (const n of fieldNames) {
    const el = form.elements.namedItem(n) as
      | HTMLInputElement
      | HTMLSelectElement;
    if (el instanceof HTMLInputElement && el.type === "checkbox")
      el.checked = !!cfg[n];
    else el.value = String(cfg[n]);
  }
  form
    .querySelectorAll<HTMLInputElement>("[data-led]")
    .forEach((c) => (c.checked = !!(cfg!.led & (1 << Number(c.dataset.led)))));
  renderPresets();
  markDirty();
}
function markDirty() {
  if (!cfg) return;
  const v = formValues();
  let dirty = 0;
  for (const n of fieldNames) {
    const el = form.elements.namedItem(n) as HTMLElement;
    const d = v[n] !== cfg[n];
    el.classList.toggle("dirty", d);
    if (d) dirty++;
  }
  if (v.led !== cfg.led) dirty++;
  const banner = $("cfgstate");
  if (v.rate_hz > v.odr_hz) {
    banner.textContent = "Stream rate cannot be above the sensor data rate.";
    banner.className = "banner bad";
  } else if (dirty) {
    banner.textContent = `${dirty} change${dirty > 1 ? "s" : ""} not applied yet.`;
    banner.className = "banner warn";
  } else if (!cfg.saved) {
    banner.textContent =
      "Running on the board but not saved: lost at power-off.";
    banner.className = "banner warn";
  } else {
    banner.textContent = "Saved on the board.";
    banner.className = "banner ok";
  }
  $<HTMLButtonElement>("cfg-apply").disabled = !dirty || v.rate_hz > v.odr_hz;
  $<HTMLButtonElement>("cfg-save").disabled =
    (!dirty && !!cfg.saved) || v.rate_hz > v.odr_hz;
}
form.addEventListener("change", markDirty);
async function applyForm() {
  if (!link || !cfg) return;
  const v = formValues(),
    cur = cfg as unknown as Record<string, number>;
  // Order so the stream rate never exceeds the data rate in between.
  const order =
    v.odr_hz >= cfg.odr_hz ? ["odr_hz", "rate_hz"] : ["rate_hz", "odr_hz"];
  for (const n of [
    ...order,
    "accel_fs_g",
    "gyro_fs_dps",
    "mag",
    "mag_hz",
    "led",
  ])
    if (v[n] !== cur[n]) await verifiedSend(`SET ${n}=${v[n]}`);
}
$("cfg-apply").onclick = () =>
  void applyForm().catch((e) => toast(String(e), true));
$("cfg-save").onclick = async () => {
  try {
    await applyForm();
    await verifiedSend("SAVE");
    if (!cfg?.saved) throw new Error("Settings were not confirmed saved");
    toast("Saved and read back");
  } catch (e) {
    toast(String(e), true);
  }
};
$("cfg-revert").onclick = () => renderConfig();
$("cfg-defaults").onclick = async () => {
  if (
    confirm(
      'Load factory defaults on the board? Press "Save to board" afterwards to keep them.',
    )
  )
    await link?.send("DEFAULTS");
};
$("cfg-export").onclick = () => {
  if (!cfg) return;
  const doc = {
    product: "ROTEM",
    firmware: info?.fw,
    board: info?.board,
    uid: info?.uid,
    saved_at: new Date().toISOString(),
    settings: cfg,
  };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }),
  );
  a.download = `rotem-${info?.uid?.slice(-8) ?? "board"}-settings.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$("cfg-import").onclick = () => $<HTMLInputElement>("cfg-file").click();
$<HTMLInputElement>("cfg-file").onchange = async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || !link || !cfg) return;
  try {
    const doc = JSON.parse(await file.text());
    const c = doc.settings as Partial<DeviceConfig>;
    if (doc.product !== "ROTEM" || !c)
      throw new Error("Not a ROTEM settings file.");
    const keys = [
      "odr_hz",
      "rate_hz",
      "accel_fs_g",
      "gyro_fs_dps",
      "mag",
      "mag_hz",
      "led",
    ] as const;
    if ((c.rate_hz ?? 0) > cfg.odr_hz)
      await verifiedSend(`SET odr_hz=${c.odr_hz}`);
    for (const k of keys)
      if (typeof c[k] === "number") await verifiedSend(`SET ${k}=${c[k]}`);
    for (const k of ["gb", "mo", "ms"] as const)
      if (Array.isArray(c[k]) && c[k]!.length === 3)
        await verifiedSend(`SET ${k}=${c[k]!.join(",")}`);
    if (
      confirm(`Loaded settings from ${file.name}. Save them on the board now?`)
    )
      await verifiedSend("SAVE");
  } catch (err) {
    alert(String(err instanceof Error ? err.message : err));
  }
};
$("boot").onclick = async () => {
  if (
    link &&
    confirm(
      "Reboot the board into firmware update mode? It stays there until flashed or unplugged.",
    )
  )
    await link.send("BOOT");
};

// ---------- fusion
const algoSel = $<HTMLSelectElement>("algo"),
  useMag = $<HTMLInputElement>("usemag");
const sliders: [string, Exclude<keyof EkfParams, "zeroRate" | "holdStill">][] =
  [
    ["k-gyro", "gyroNoise"],
    ["k-bias", "biasNoise"],
    ["k-acc", "accelNoise"],
    ["k-head", "headingNoise"],
  ];
function renderFusion() {
  algoSel.value = prefs.algo;
  useMag.checked = useMagNow();
  if (prefs.ekf.zeroRate === undefined) prefs.ekf.zeroRate = true;
  $<HTMLInputElement>("zerorate").checked = prefs.ekf.zeroRate;
  $("ekfparams").hidden = prefs.algo !== "ekf";
  $("madparams").hidden = prefs.algo !== "madgwick";
  $("filterchip").textContent = useBoard()
    ? `On-board Kalman${boardFusion && boardFusion.flags & 4 ? " · 9-axis" : " · 6-axis"}`
    : `App ${prefs.algo === "ekf" ? "Kalman" : "Madgwick"} · ${useMagNow() ? "9-axis" : "6-axis"}`;
  $<HTMLSelectElement>("fsource").value = prefs.source;
  $("magnote").textContent = !cfg?.mag
    ? "The magnetometer is switched off in Board settings."
    : magCalibrated()
      ? `Calibrated on this board${prefs.useMag === null ? ", so it is on by default" : ""}. Axes: ${describeAxes(MAG_AXES[cfg.ma])}.`
      : "Not calibrated yet: run Calibration, then it turns on by itself. Without it heading is relative and drifts slowly.";
  for (const [id, key] of sliders) {
    $<HTMLInputElement>(id).value = String(prefs.ekf[key]);
    $(id + "-v").textContent = String(prefs.ekf[key]);
  }
  $<HTMLInputElement>("beta").value = String(prefs.beta);
  $("beta-v").textContent = prefs.beta.toFixed(2);
}
const zeroRate = $<HTMLInputElement>("zerorate");
zeroRate.onchange = () => {
  prefs.ekf.zeroRate = zeroRate.checked;
  ekf.p = prefs.ekf;
  savePrefs();
};
$<HTMLSelectElement>("fsource").onchange = (e) => {
  prefs.source = (e.target as HTMLSelectElement).value as "board" | "app";
  savePrefs();
  renderFusion();
};
algoSel.onchange = () => {
  prefs.algo = algoSel.value as "ekf" | "madgwick";
  savePrefs();
  renderFusion();
};
useMag.onchange = () => {
  prefs.useMag = useMag.checked;
  savePrefs();
  ekf.reset();
  madgwick.reset();
  renderFusion();
};
for (const [id, key] of sliders) {
  $<HTMLInputElement>(id).oninput = (e) => {
    prefs.ekf[key] = Number((e.target as HTMLInputElement).value);
    ekf.p = prefs.ekf;
    $(id + "-v").textContent = String(prefs.ekf[key]);
    savePrefs();
  };
}
$<HTMLInputElement>("beta").oninput = (e) => {
  prefs.beta = Number((e.target as HTMLInputElement).value);
  madgwick.beta = prefs.beta;
  $("beta-v").textContent = prefs.beta.toFixed(2);
  savePrefs();
};
$("k-reset").onclick = () => {
  prefs.ekf = { ...EKF_DEFAULTS };
  ekf.p = prefs.ekf;
  savePrefs();
  renderFusion();
};
$("f-reset").onclick = () => {
  ekf.reset();
  madgwick.reset();
};
renderFusion();

// ---------- calibration
$("cal-gyro").onclick = () => {
  if (!last) return;
  gyroCal = { sum: [0, 0, 0], n: 0, until: performance.now() + 3000 };
  $("cal-gyro").textContent = "Hold still…";
  $<HTMLButtonElement>("cal-gyro").disabled = true;
  $("gyro-msg").textContent = "Measuring. Don't touch the board or the table.";
  const t0 = performance.now();
  const tick = () => {
    if (!gyroCal) return;
    const f = Math.min(1, (performance.now() - t0) / 3000);
    $("gyro-ring-fg").style.strokeDashoffset = String(106.8 * (1 - f));
    $("gyro-ring-t").textContent = String(Math.ceil(3 * (1 - f)) || "");
    requestAnimationFrame(tick);
  };
  tick();
};
function finishGyroCal() {
  const c = gyroCal!;
  gyroCal = null;
  gyroMeasured = c.sum.map((v) => v / c.n);
  $("cal-gyro-v").textContent =
    gyroMeasured.map((v) => v.toFixed(3)).join(", ") + ` (${c.n} samples)`;
  $("cal-gyro").textContent = "Measure";
  $<HTMLButtonElement>("cal-gyro").disabled = false;
  // A real rest shows a small spread; motion during the measurement makes it large.
  const moving = !ekf.still;
  $<HTMLButtonElement>("cal-gyro-save").disabled = !cfg || moving;
  $("gyro-ring-t").textContent = moving ? "!" : "✓";
  $("gyro-msg").textContent = moving
    ? "The board moved during the measurement. Put it down and try again."
    : `Drift found: ${Math.hypot(...gyroMeasured).toFixed(3)} °/s. Press Save to board.`;
  if (!moving) toast("Measured. Save it to the board to keep it.");
  ekf.reset();
  madgwick.reset();
}
$("cal-gyro-save").onclick = async () => {
  if (!link || !gyroMeasured) return;
  try {
    await verifiedSend(
      `SET gb=${gyroMeasured.map((v) => Math.round(v * 1000)).join(",")}`,
    );
    await verifiedSend("SAVE");
    $<HTMLButtonElement>("cal-gyro-save").disabled = true;
    $("gyro-msg").textContent =
      "Saved and read back. Reboot to verify persistence.";
  } catch (e) {
    $("gyro-msg").textContent = String(e);
  }
};
$("cal-mag").onclick = () => {
  if (!last || !cfg?.mag) {
    alert("Switch the magnetometer on in Board settings first.");
    return;
  }
  const now = performance.now();
  magCal = {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
    bins: new Set(),
    until: now + 30000,
    start: now,
  };
  magSamples = [];
  $("cal-mag").textContent = "Turning…";
  $<HTMLButtonElement>("cal-mag").disabled = true;
  paintGrid(new Set());
  $("mag-msg").textContent = "Start turning it slowly in every direction.";
  for (const id of [
    "cal-mag-off",
    "cal-mag-scale",
    "cal-mag-axes",
    "cal-mag-field",
  ])
    $(id).textContent = "–";
};
function feedMagCal(
  m: number[],
  gyroRad: number[],
  accel: number[],
  t: number,
  now: number,
) {
  const c = magCal!;
  magSamples.push({ t, gyro: gyroRad, raw: m, accel });
  for (let i = 0; i < 3; i++) {
    c.min[i] = Math.min(c.min[i], m[i]);
    c.max[i] = Math.max(c.max[i], m[i]);
  }
  // Coverage: 8 azimuth x 4 elevation bins of the field direction about the running centre.
  const ctr = c.min.map((v, i) => (v + c.max[i]) / 2),
    d = m.map((v, i) => v - ctr[i]);
  const n = Math.hypot(...d);
  if (n > 0) {
    const az =
      Math.floor(((Math.atan2(d[1], d[0]) + Math.PI) / (2 * Math.PI)) * 8) % 8;
    const el = Math.min(
      3,
      Math.floor(((Math.asin(d[2] / n) + Math.PI / 2) / Math.PI) * 4),
    );
    c.bins.add(az * 4 + el);
  }
  const cov = c.bins.size / 32;
  paintGrid(c.bins);
  const rowsHit = [0, 1, 2, 3].map(
    (el) => [...c.bins].filter((b) => b % 4 === el).length,
  );
  const weakest = rowsHit.indexOf(Math.min(...rowsHit));
  $("mag-msg").textContent =
    cov > 0.85
      ? "Great coverage. Keep going until the bar is full."
      : [
          "Now turn it so the field points into the bottom: tip it face down.",
          "Tilt it the other way, about halfway down.",
          "Tilt it halfway up.",
          "Now face the top up and turn it slowly around.",
        ][weakest];
  $<HTMLDivElement>("cal-mag-bar").style.width =
    `${Math.min(100, ((now - c.start) / 30000) * 100)}%`;
  $("cal-mag-cov").textContent = `${(cov * 100).toFixed(0)} %`;
  if (now < c.until) return;
  magCal = null;
  $("cal-mag").textContent = "Start";
  $<HTMLButtonElement>("cal-mag").disabled = false;
  // Hard iron: centre of the min/max box; soft iron (diagonal): equalise the three radii.
  const off = c.min.map((v, i) => Math.round((v + c.max[i]) / 2));
  const rad = c.min.map((v, i) => (c.max[i] - v) / 2),
    avg = (rad[0] + rad[1] + rad[2]) / 3;
  const sc = rad.map((r) => avg / r);
  $("cal-mag-off").textContent = off.join(", ");
  $("cal-mag-scale").textContent = sc.map((v) => v.toFixed(3)).join(", ");
  $("cal-mag-field").textContent =
    `${(avg / MAG_LSB_PER_GAUSS).toFixed(3)} G (Earth here: about 0.44 G)`;
  // Axes: which map makes the field turn as the gyro says it should.
  const rot: RotSample[] = magSamples.map((x) => ({
    t: x.t,
    gyro: x.gyro,
    accel: x.accel,
    mag: x.raw.map((v, i) => ((v - off[i]) * sc[i]) / MAG_LSB_PER_GAUSS),
  }));
  const fit = findMagAxes(rot);
  let axes = cfg?.ma ?? 0,
    axesOk = false;
  if (fit && fit.motion > 6 && fit.margin > 3) {
    axes = fit.index;
    axesOk = true;
    $("cal-mag-axes").textContent =
      `${describeAxes(MAG_AXES[axes])}${axes === 0 ? " (as the datasheet says)" : " (differs from the datasheet)"} · dip ${fit.dip.toFixed(0)}°`;
  } else {
    $("cal-mag-axes").textContent =
      `not enough turning to check (kept ${describeAxes(MAG_AXES[axes])})`;
  }
  const good = cov > 0.6 && sc.every((v) => v > 0.7 && v < 1.4);
  magResult = good ? { off, sc, axes } : null;
  $<HTMLButtonElement>("cal-mag-save").disabled = !good;
  const strength = avg / MAG_LSB_PER_GAUSS;
  $("mag-msg").textContent = !good
    ? "Not enough directions covered. Press Start and turn it more slowly through every side."
    : strength > 0.75
      ? "Done, but the field is unusually strong: something magnetic was close. Try again further from the laptop."
      : `Done. Press Save to board.${axesOk ? "" : " (Axes kept as before: turn more next time to check them.)"}`;
  if (good) toast("Compass measured. Save it to the board to keep it.");
}
$("cal-mag-save").onclick = async () => {
  if (!link || !magResult) return;
  try {
    await verifiedSend(`SET mo=${magResult.off.join(",")}`);
    await verifiedSend(
      `SET ms=${magResult.sc.map((v) => Math.round(v * 1e6)).join(",")}`,
    );
    await verifiedSend(`SET ma=${magResult.axes}`);
    await verifiedSend("SAVE");
    $<HTMLButtonElement>("cal-mag-save").disabled = true;
    $("mag-msg").textContent =
      "Saved and read back. Verify heading and axes against a known reference.";
  } catch (e) {
    $("mag-msg").textContent = String(e);
    return;
  }
  ekf.reset();
  madgwick.reset();
};

// ---------- view buttons, console
const referenceGuide = $<HTMLDialogElement>("reference-guide");
$("zero").onclick = () => {
  $("reference-feedback").textContent = "";
  referenceGuide.showModal();
};
$("reference-calibration").onclick = () => { referenceGuide.close(); showTab("cal"); };
$("reference-confirm").onclick = () => {
  if (!last || performance.now() - lastArrival > 2000) {
    $("reference-feedback").textContent = "Connect the board and wait for fresh readings first.";
    return;
  }
  view.zero();
  referenceGuide.close();
  toast("Display reference set. Sensor readings are unchanged.");
};
$("unzero").onclick = () => view.unzero();
$("camreset").onclick = () => view.resetCamera();
$("selftest").onclick = async () => {
  if (!link) return;
  tests = [];
  renderTests();
  await link.send("TEST");
};
$("cmdform").onsubmit = async (e) => {
  e.preventDefault();
  const c = ($("cmd") as HTMLInputElement).value.trim();
  if (!c || !link) return;
  log("> " + c);
  await link.send(c);
  ($("cmd") as HTMLInputElement).value = "";
};

// ---------- connection
async function handshake() {
  if (!link) return;
  last = null;
  lost = 0;
  tests = [];
  info = null;
  cfg = null;
  renderTests();
  renderConfig();
  boardTimes = [];
  magTimes = [];
  ekf.reset();
  madgwick.reset();
  if (link.kind === "serial") await link.send("STREAM OFF");
  for (const c of ["INFO", "GET", "TEST", "RAILS"]) await link.send(c);
  if (link.kind === "serial") await link.send("STREAM ON");
  renderDevice();
}

function attach(l: Link) {
  link = l;
  l.onLine = onLine;
  l.onClose = (why) => {
    if (link !== l) return;
    commands.cancel();
    log("link closed: " + why);
    link = null;
    hubDevice = null;
    last = null;
    renderDevice();
    renderHealth();
    // Reconnection is an explicit user action.
  };
  renderDevice();
}

async function tryHub(): Promise<boolean> {
  if (link || !(await HubLink.available())) return false;
  const l = new HubLink();
  try {
    await l.open();
    attach(l);
    log("connected through rotem-hub");
    return true;
  } catch {
    return false;
  }
}

async function openSerial(port?: SerialPort) {
  const l = new SerialLink();
  await l.open(port);
  attach(l);
  await handshake();
}

$("connect").onclick = async () => {
  try {
    if (link) {
      commands.cancel();
      const l = link;
      link = null;
      last = null;
      await l.close();
      renderDevice();
      renderHealth();
      return;
    }
    if (await HubLink.available()) {
      await tryHub();
      return;
    }
    if (!SerialLink.supported()) {
      $("unsupported").hidden = false;
      return;
    }
    await openSerial();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log("connect failed: " + msg);
    if (!/No port selected/.test(msg)) alert(msg);
    link = null;
    renderDevice();
  }
};

// Never open a serial port or local hub until the user chooses Connect.
if (!SerialLink.supported()) $("unsupported").hidden = false;
renderDevice();
renderConfig();
renderHealth();

// Public workbench controls.
$("theme-toggle").onclick = () => {
  document.body.classList.toggle("dark");
  $("theme-toggle").textContent = document.body.classList.contains("dark")
    ? "Light appearance"
    : "Dark appearance";
};
async function canAction(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    $("can-result").textContent = String(e);
  }
}
$("can-status").onclick = () =>
  void canAction(async () => {
    const reply = await commands.request("CAN STATUS", (s) =>
      s.startsWith("CAN "),
    );
    $("can-result").textContent = reply;
  });
$("can-stop").onclick = () =>
  void canAction(async () => {
    const reply = await commands.request("CAN STOP", (s) =>
      s.startsWith("CAN "),
    );
    $("can-result").textContent = reply;
  });
$("can-apply").onclick = () =>
  void canAction(async () => {
    const node = Number($<HTMLInputElement>("can-node").value),
      rate = Number($<HTMLSelectElement>("can-kbps").value);
    if (
      !Number.isInteger(node) ||
      node < 0 ||
      node > 63 ||
      ![125, 250, 500, 1000].includes(rate)
    )
      throw new Error("Invalid CAN settings");
    await verifiedSend(`SET can_node=${node}`);
    const reply = await verifiedSend(`SET can_kbps=${rate}`);
    const f = fields(reply);
    if (Number(f.can_node) !== node || Number(f.can_kbps) !== rate)
      throw new Error("Readback differs from requested settings");
    $("can-result").textContent =
      "Applied and read back. Save to keep after reboot.\n" + reply;
  });
$("can-save").onclick = () =>
  void canAction(async () => {
    const reply = await verifiedSend("SAVE");
    if (fields(reply).saved !== "1") throw new Error("Save not confirmed");
    $("can-result").textContent =
      "Saved and read back. Verify again after reboot.\n" + reply;
  });

document.querySelectorAll<HTMLButtonElement>("[data-can-rate]").forEach(
  (b) =>
    (b.onclick = () => {
      $<HTMLInputElement>("can-kbps").value = b.dataset.canRate!;
      document
        .querySelectorAll<HTMLElement>("[data-can-rate]")
        .forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    }),
);
$("can-start").onclick = () =>
  void canAction(async () => {
    const rate = Number($<HTMLInputElement>("can-kbps").value);
    if (![125, 250, 500, 1000].includes(rate))
      throw new Error("Invalid bitrate");
    $("can-result").textContent = await commands.request(
      `CAN START ${rate}`,
      (s) => s.startsWith("CAN "),
    );
  });
