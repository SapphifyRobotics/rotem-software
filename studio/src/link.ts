// Two ways to reach a ROTEM, same interface:
//  HubLink    WebSocket to rotem-hub (server/hub.mjs), which owns the port and shares it with many browsers;
//  SerialLink Web Serial, this browser alone holds the port.

export const ROTEM_USB = { usbVendorId: 0xcafe, usbProductId: 0x4010 };

export interface Link {
  readonly kind: 'hub' | 'serial';
  onLine: (line: string) => void;
  onClose: (reason: string) => void;
  send(cmd: string): Promise<void>;
  close(): Promise<void>;
}

function splitter(onLine: (l: string) => void) {
  let buf = '';
  return (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  };
}

export class HubLink implements Link {
  readonly kind = 'hub';
  onLine: (line: string) => void = () => {};
  onClose: (reason: string) => void = () => {};
  private ws!: WebSocket;
  private closed = false;

  /** Resolves when a hub answers at this page's origin; rejects quickly otherwise. */
  static async available(): Promise<boolean> {
    try {
      const r = await fetch('/hub', { signal: AbortSignal.timeout(2500), cache: 'no-store' });
      return r.ok && (await r.json()).hub === 1;
    } catch { return false; }
  }

  async open() {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    this.ws = new WebSocket(url);
    const feed = splitter((l) => this.onLine(l));
    this.ws.onmessage = (e) => feed(String(e.data));
    this.ws.onclose = () => { if (!this.closed) this.onClose('hub connection closed'); };
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('hub not reachable'));
    });
  }

  async send(cmd: string) { this.ws.send(cmd + '\n'); }
  async close() { this.closed = true; this.ws.close(); }
}

export class SerialLink implements Link {
  readonly kind = 'serial';
  onLine: (line: string) => void = () => {};
  onClose: (reason: string) => void = () => {};
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<string> | null = null;
  private writer: WritableStreamDefaultWriter<string> | null = null;
  private piping: Promise<void> | null = null;

  static supported() { return 'serial' in navigator; }

  async open(port?: SerialPort) {
    this.port = port ?? await navigator.serial.requestPort({ filters: [ROTEM_USB] });
    try { await this.port.open({ baudRate: 115200 }); }
    catch (e) {
      throw new Error(String(e).includes('already open') || String(e).includes('Failed to open')
        ? 'The port is held by another program or tab. Close it there, or run rotem-hub to share the board.'
        : String(e));
    }
    const enc = new TextEncoderStream();
    this.piping = enc.readable.pipeTo(this.port.writable! as unknown as WritableStream<Uint8Array>);
    this.writer = enc.writable.getWriter();
    const dec = new TextDecoderStream();
    void this.port.readable!.pipeTo(dec.writable as unknown as WritableStream<Uint8Array>).catch(() => {});
    this.reader = dec.readable.getReader();
    void this.pump();
  }

  private async pump() {
    const feed = splitter((l) => this.onLine(l));
    try {
      for (;;) {
        const { value, done } = await this.reader!.read();
        if (done) break;
        feed(value);
      }
      this.onClose('closed');
    } catch (e) { this.onClose(String(e)); }
  }

  async send(cmd: string) {
    if (!this.writer) throw new Error('not connected');
    await this.writer.write(cmd + '\n');
  }

  async close() {
    try { await this.send('STREAM OFF'); } catch { /* gone */ }
    try { await this.reader?.cancel(); } catch { /* ignore */ }
    try { await this.writer?.close(); await this.piping; } catch { /* ignore */ }
    try { await this.port?.close(); } catch { /* ignore */ }
    this.port = null; this.reader = null; this.writer = null;
  }
}
