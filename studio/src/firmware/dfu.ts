import { FLASH_BASE, MAX_IMAGE } from "./release";

/** STM32 DfuSe, internal flash only. No mass erase or option-byte operations. */
export class Dfu {
  private iface = -1;
  private readonly chunk = 1024;
  constructor(private device: USBDevice, private expectedSerial: string) {}
  async open() {
    if (this.device.vendorId !== 0x0483 || this.device.productId !== 0xdf11
      || this.device.serialNumber?.toUpperCase() !== this.expectedSerial.toUpperCase())
      throw new Error("This DFU device is not the ROTEM you connected. Nothing was written.");
    await this.device.open();
    if (!this.device.configuration) await this.device.selectConfiguration(1);
    for (const i of this.device.configuration!.interfaces) {
      const alt = i.alternates.find(a => a.alternateSetting === 0 && a.interfaceClass === 0xfe
        && a.interfaceSubclass === 1 && a.interfaceProtocol === 2
        && /Internal Flash.*0x08000000.*\d+\*008Kg/i.test(a.interfaceName ?? ""));
      if (alt) { this.iface = i.interfaceNumber; break; }
    }
    if (this.iface < 0) throw new Error("Unexpected DFU memory layout. Use the documented recovery tool.");
    await this.device.claimInterface(this.iface);
    await this.device.selectAlternateInterface(this.iface, 0);
    const s = await this.input(3, 0, 6);
    if (s.getUint8(4) === 10) await this.output(4, 0);
    await this.output(6, 0);
  }
  private setup(request: number, value: number): USBControlTransferParameters {
    return { requestType: "class", recipient: "interface", request, value, index: this.iface };
  }
  private async output(request: number, value: number, data = new Uint8Array(0)) {
    const r = await this.device.controlTransferOut(this.setup(request, value), data);
    if (r.status !== "ok" || r.bytesWritten !== data.length) throw new Error("USB write failed. Keep the board in DFU and retry recovery.");
  }
  private async input(request: number, value: number, length: number) {
    const r = await this.device.controlTransferIn(this.setup(request, value), length);
    if (r.status !== "ok" || !r.data || r.data.byteLength !== length) throw new Error("Incomplete USB read.");
    return r.data;
  }
  private async ready() {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const s = await this.input(3, 0, 6);
      if (s.getUint8(0)) throw new Error(`DFU error ${s.getUint8(0)}. No further writes attempted.`);
      if (s.getUint8(4) === 5) return;
      if (![3, 4].includes(s.getUint8(4))) throw new Error(`Unexpected DFU state ${s.getUint8(4)}.`);
      const wait = s.getUint8(1) + (s.getUint8(2) << 8) + (s.getUint8(3) << 16);
      if (wait > 30000) throw new Error("Invalid DFU polling interval.");
      await new Promise(r => setTimeout(r, Math.max(wait, 5)));
    }
    throw new Error("DFU operation timed out. Reconnect in recovery mode.");
  }
  private async command(command: number, address: number) {
    if (address < FLASH_BASE || address >= FLASH_BASE + MAX_IMAGE) throw new Error("Address outside application region.");
    const bytes = new Uint8Array(5); bytes[0] = command;
    new DataView(bytes.buffer).setUint32(1, address, true);
    await this.output(1, 0, bytes); await this.ready();
  }
  async read(length: number, progress: (fraction: number) => void) {
    if (!Number.isInteger(length) || length < 8 || length > MAX_IMAGE) throw new Error("Invalid read size.");
    await this.output(6, 0);
    await this.command(0x21, FLASH_BASE);
    await this.output(6, 0);
    const result = new Uint8Array(length);
    for (let offset = 0; offset < length; offset += this.chunk) {
      const n = Math.min(this.chunk, length - offset);
      const data = await this.input(2, 2 + offset / this.chunk, n);
      result.set(new Uint8Array(data.buffer, data.byteOffset, n), offset);
      progress((offset + n) / length);
    }
    await this.output(6, 0);
    return result;
  }
  async write(image: Uint8Array, progress: (stage: string, fraction: number) => void) {
    if (image.length < 8 || image.length > MAX_IMAGE) throw new Error("Invalid write size.");
    const span = Math.ceil(image.length / 8192) * 8192;
    if (span > MAX_IMAGE) throw new Error("Image would touch protected settings.");
    for (let offset = 0; offset < span; offset += 8192) {
      await this.command(0x41, FLASH_BASE + offset);
      progress("Erasing application pages", (offset + 8192) / span);
    }
    await this.command(0x21, FLASH_BASE);
    for (let offset = 0; offset < image.length; offset += this.chunk) {
      // STM32 U5 programs 16-byte flash words; only pad the last transfer.
      const n = Math.min(this.chunk, image.length - offset);
      const block = new Uint8Array(Math.ceil(n / 16) * 16).fill(255);
      block.set(image.subarray(offset, offset + n));
      await this.output(1, 2 + offset / this.chunk, block); await this.ready();
      progress("Writing firmware", (offset + n) / image.length);
    }
    const actual = await this.read(span, f => progress("Verifying readback", f));
    for (let i = 0; i < span; i++) {
      if (actual[i] !== (i < image.length ? image[i] : 255)) throw new Error(`Readback mismatch at byte ${i}. Do not start the application; retry recovery.`);
    }
  }
  async restart() {
    await this.output(6, 0); await this.command(0x21, FLASH_BASE);
    await this.output(1, 2);
    // The ROM disconnects while GETSTATUS executes manifestation.
    try { await this.input(3, 0, 6); } catch { /* reconnect and INFO are required */ }
  }
  async close() { if (this.device.opened) await this.device.close(); }
}
