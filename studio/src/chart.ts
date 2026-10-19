// Three-trace strip chart on a canvas, last `seconds` of data.

export class Strip {
  private data: number[][] = [[], [], []];
  private ctx: CanvasRenderingContext2D;
  constructor(private canvas: HTMLCanvasElement, private range: number,
              private colors: string[], private points = 500) {
    this.ctx = canvas.getContext('2d')!;
  }
  push(v: number[]) {
    for (let i = 0; i < 3; i++) {
      this.data[i].push(v[i]);
      if (this.data[i].length > this.points) this.data[i].shift();
    }
  }
  draw() {
    const c = this.canvas, dpr = devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.strokeStyle = getComputedStyle(c).getPropertyValue('--grid') || '#333';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
    for (let i = 0; i < 3; i++) {
      const d = this.data[i];
      g.strokeStyle = this.colors[i]; g.lineWidth = 1.5; g.beginPath();
      d.forEach((v, k) => {
        const x = (k / (this.points - 1)) * w;
        const y = h / 2 - (Math.max(-this.range, Math.min(this.range, v)) / this.range) * (h / 2 - 2);
        k ? g.lineTo(x, y) : g.moveTo(x, y);
      });
      g.stroke();
    }
  }
}
