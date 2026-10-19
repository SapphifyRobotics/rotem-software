// Fallback when the browser has no WebGL: the board, its plugs and its enclosure as shaded boxes
// on a 2D canvas. Units: 1 = 25 mm (half the board); board mid-plane at z = 0. Box sizes come from
// the same STLs the 3D view loads (06_mechanical/source, enclosure frame: board underside z = 9 mm).
type V = [number, number, number];
type Mode = 'board' | 'plugs' | 'enclosure';
interface Box { min: V; max: V; fill: string; stroke: string; alpha: number }

const mm = (x: number, y: number, z: number): V => [x / 25, y / 25, (z - 9.8) / 25];
const box = (a: V, b: V, fill: string, stroke: string, alpha = 1): Box => ({ min: a, max: b, fill, stroke, alpha });

const BOARD = box(mm(-25, -25, 9), mm(25, 25, 10.6), '#4f8f6e', '#1d3a2c');
const USB_RECEPTACLE = box(mm(-4.5, 18, 10.6), mm(4.5, 25.5, 13.8), '#b8bfcc', '#6b7385');
const HEADERS = [-9, 9].map((x) => box(mm(x - 4.3, -25.5, 10.6), mm(x + 4.3, -16, 20.4), '#eeeeee', '#9a9a9a'));
const SCREWS = [[-19, -19], [19, -19], [-19, 19], [19, 19]].map(([x, y]) => box(mm(x - 2.75, y - 2.75, 10.6), mm(x + 2.75, y + 2.75, 13.6), '#c3c9d4', '#7b8494'));
const PLUGS = [
  box(mm(-6.18, 25.5, 6.17), mm(6.18, 53.65, 12.67), '#3a3f48', '#1d2026'),
  box(mm(4.86, -39.16, 7.64), mm(13.14, -25.16, 18.48), '#2b2f36', '#15171b'),
  box(mm(-13.14, -39.16, 7.64), mm(-4.86, -25.16, 18.48), '#2b2f36', '#15171b'),
];
const ENCLOSURE = [
  box(mm(-28, -28, 0), mm(28, 28, 23.19), '#cfd6e4', '#8c97ad', 0.35),
  box(mm(-28, -28, 23.19), mm(28, 28, 28.39), '#dfe5f0', '#8c97ad', 0.22),
];

export class FlatBoardView {
  private canvas = document.createElement('canvas');
  private q = [1, 0, 0, 0];
  private tare = [1, 0, 0, 0];
  private mode: Mode = 'board';
  loaded = Promise.resolve();

  constructor(private host: HTMLElement) {
    this.canvas.style.width = '100%'; this.canvas.style.height = '100%';
    host.appendChild(this.canvas);
    const loop = () => { this.draw(); requestAnimationFrame(loop); };
    loop();
  }

  setOrientation(q: number[]) { this.q = q.slice(); }
  zero() { this.tare = [this.q[0], -this.q[1], -this.q[2], -this.q[3]]; }
  unzero() { this.tare = [1, 0, 0, 0]; }
  resetCamera() {}
  setMode(mode: string) { this.mode = mode as Mode; }

  private rot(v: V): V {
    const m = (a: number[], b: number[]) => [
      a[0]*b[0] - a[1]*b[1] - a[2]*b[2] - a[3]*b[3],
      a[0]*b[1] + a[1]*b[0] + a[2]*b[3] - a[3]*b[2],
      a[0]*b[2] - a[1]*b[3] + a[2]*b[0] + a[3]*b[1],
      a[0]*b[3] + a[1]*b[2] - a[2]*b[1] + a[3]*b[0]];
    const q = m(this.tare, this.q);
    const r = m(m(q, [0, ...v]), [q[0], -q[1], -q[2], -q[3]]);
    return [r[1], r[2], r[3]];
  }

  private draw() {
    const c = this.canvas, dpr = devicePixelRatio || 1;
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const zoom = this.mode === 'enclosure' ? 0.22 : this.mode === 'plugs' ? 0.2 : 0.3;
    const s = Math.min(w, h) * zoom;
    // Camera above and in front, 50 degrees; world z up.
    const e = 50 * Math.PI / 180;
    const view = (p: V): [number, number, number] => {
      const up = p[1] * Math.sin(e) + p[2] * Math.cos(e);
      const toward = -p[1] * Math.cos(e) + p[2] * Math.sin(e);
      return [w / 2 + p[0] * s, h / 2 + 20 - up * s, toward];
    };

    const boxes: Box[] = [BOARD, USB_RECEPTACLE, ...HEADERS, ...SCREWS];
    if (this.mode !== 'board') boxes.push(...PLUGS);
    if (this.mode === 'enclosure') boxes.push(...ENCLOSURE);

    // Every face of every box, sorted far to near (painter's algorithm).
    const faces: { pts: [number, number, number][]; depth: number; b: Box; shade: number }[] = [];
    const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
    const normals: V[] = [[0, 0, -1], [0, 0, 1], [0, -1, 0], [0, 1, 0], [-1, 0, 0], [1, 0, 0]];
    for (const b of boxes) {
      const corners: V[] = [];
      for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) corners.push(this.rot([x, y, z]));
      quads.forEach((qd, i) => {
        const pts = qd.map((k) => view(corners[k]));
        const n = this.rot(normals[i]);
        const shade = 0.55 + 0.45 * Math.max(0, n[2] * 0.8 - n[1] * 0.2);
        faces.push({ pts, depth: pts.reduce((a, p) => a + p[2], 0) / 4, b, shade });
      });
    }
    faces.sort((a, b) => a.depth - b.depth);
    for (const f of faces) {
      g.globalAlpha = f.b.alpha;
      g.beginPath(); f.pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath();
      g.fillStyle = f.b.fill; g.fill();
      g.globalAlpha = f.b.alpha * (1 - f.shade) * 0.9; g.fillStyle = '#000'; g.fill();
      g.globalAlpha = Math.min(1, f.b.alpha + 0.3); g.strokeStyle = f.b.stroke; g.lineWidth = 1; g.stroke();
    }
    g.globalAlpha = 1;

    const o = view(this.rot([0, 0, 0.04]));
    ([[[0.9, 0, 0.04], '#e5484d', 'x'], [[0, 0.9, 0.04], '#10a36b', 'y'], [[0, 0, 0.9], '#3157f6', 'z']] as [V, string, string][]).forEach(([v, col, name]) => {
      const p = view(this.rot(v));
      g.strokeStyle = col; g.lineWidth = 2.5; g.beginPath(); g.moveTo(o[0], o[1]); g.lineTo(p[0], p[1]); g.stroke();
      g.fillStyle = col; g.font = '600 12px system-ui'; g.fillText(name, p[0] + 4, p[1] - 4);
    });
    g.lineWidth = 1;
  }
}
