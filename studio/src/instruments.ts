// Small 2D instruments: artificial horizon and heading.
// Drawn on the light stage, so the colours are fixed dark-on-light.
const INK = "#0f172a",
  MUTED = "#64748b",
  RING = "rgba(15,23,42,.12)",
  LIME = "#3157f6",
  RED = "#e5484d";
const css = (v: string) =>
  (
    ({
      "--text": INK,
      "--line": RING,
      "--muted": MUTED,
      "--bad": RED,
      "--accent": LIME,
    }) as Record<string, string>
  )[v];

function prep(c: HTMLCanvasElement) {
  const dpr = devicePixelRatio || 1,
    w = c.clientWidth,
    h = c.clientHeight;
  if (c.width !== w * dpr) {
    c.width = w * dpr;
    c.height = h * dpr;
  }
  const g = c.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h, r: Math.min(w, h) / 2 - 8 };
}

export function drawHorizon(
  c: HTMLCanvasElement,
  rollDeg: number,
  pitchDeg: number,
) {
  const { g, w, h, r } = prep(c);
  g.save();
  g.translate(w / 2, h / 2);
  g.beginPath();
  g.arc(0, 0, r, 0, Math.PI * 2);
  g.clip();
  g.rotate((-rollDeg * Math.PI) / 180);
  const off = (pitchDeg / 45) * r;
  g.fillStyle = "#7fa4ff";
  g.fillRect(-2 * r, -2 * r + off, 4 * r, 2 * r);
  g.fillStyle = "#c9b48f";
  g.fillRect(-2 * r, off, 4 * r, 2 * r);
  g.strokeStyle = "#fff";
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(-2 * r, off);
  g.lineTo(2 * r, off);
  g.stroke();
  g.lineWidth = 1;
  g.font = "9px system-ui";
  g.fillStyle = "#fff";
  for (const p of [-20, -10, 10, 20]) {
    const y = off - (p / 45) * r,
      l = r * 0.25;
    g.beginPath();
    g.moveTo(-l, y);
    g.lineTo(l, y);
    g.stroke();
  }
  g.restore();
  g.save();
  g.translate(w / 2, h / 2);
  g.strokeStyle = css("--text");
  g.lineWidth = 2.5;
  g.beginPath();
  g.moveTo(-r * 0.55, 0);
  g.lineTo(-r * 0.15, 0);
  g.lineTo(0, r * 0.12);
  g.lineTo(r * 0.15, 0);
  g.lineTo(r * 0.55, 0);
  g.stroke();
  g.strokeStyle = css("--line");
  g.lineWidth = 2;
  g.beginPath();
  g.arc(0, 0, r, 0, Math.PI * 2);
  g.stroke();
  g.restore();
}

export function drawCompass(c: HTMLCanvasElement, headingDeg: number) {
  const { g, w, h, r } = prep(c);
  g.save();
  g.translate(w / 2, h / 2);
  g.strokeStyle = css("--line");
  g.lineWidth = 2;
  g.beginPath();
  g.arc(0, 0, r, 0, Math.PI * 2);
  g.stroke();
  g.rotate((-headingDeg * Math.PI) / 180);
  g.fillStyle = css("--muted");
  g.strokeStyle = css("--muted");
  g.font = "600 10px system-ui";
  g.textAlign = "center";
  g.textBaseline = "middle";
  for (let a = 0; a < 360; a += 30) {
    g.save();
    g.rotate((a * Math.PI) / 180);
    g.lineWidth = a % 90 ? 1 : 2;
    g.beginPath();
    g.moveTo(0, -r);
    g.lineTo(0, -r + (a % 90 ? 5 : 8));
    g.stroke();
    if (a % 90 === 0) {
      g.fillStyle = a === 0 ? css("--bad") : css("--text");
      g.fillText("NESW"[a / 90], 0, -r + 17);
    }
    g.restore();
  }
  g.restore();
  g.save();
  g.translate(w / 2, h / 2);
  g.fillStyle = css("--accent");
  g.beginPath();
  g.moveTo(0, -r * 0.5);
  g.lineTo(6, 6);
  g.lineTo(0, 2);
  g.lineTo(-6, 6);
  g.closePath();
  g.fill();
  g.fillStyle = css("--text");
  g.font = "600 11px ui-monospace, monospace";
  g.textAlign = "center";
  g.fillText(`${((headingDeg % 360) + 360) % 360 | 0}°`, 0, r * 0.45);
  g.restore();
}
