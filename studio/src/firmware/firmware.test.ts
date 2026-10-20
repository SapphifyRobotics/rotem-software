import { describe, expect, it } from "vitest";
import { Dfu } from "./dfu";
import { compatible, dfuSerial, FLASH_BASE, MAX_IMAGE, validateRelease, verifyImage, type Release } from "./release";

async function fixture() {
  const image = new Uint8Array(1537).fill(42);
  const v = new DataView(image.buffer); v.setUint32(0, 0x20030000, true); v.setUint32(4, FLASH_BASE + 9, true);
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", image)), b => b.toString(16).padStart(2, "0")).join("");
  const release: Release = { version: "0.6.4", commit: "abcdef0", dirty: 0, sha256, tag: "v0.6.4-test", channel: "experimental", hardware_revisions: ["C1"], bytes: image.length, image: `/firmware/${sha256}.bin`, physical_tests: "Test fixture" };
  return { image, release };
}
function fakeDevice() {
  const memory = new Uint8Array(MAX_IMAGE).fill(0x55);
  let address = FLASH_BASE, state = 2, corrupt = false, disconnected = false;
  const writes: number[] = [], erased: number[] = [];
  const device = {
    vendorId: 0x0483, productId: 0xdf11, serialNumber: "000000040002", opened: true,
    configuration: { interfaces: [{ interfaceNumber: 0, alternates: [{ alternateSetting: 0, interfaceClass: 0xfe, interfaceSubclass: 1, interfaceProtocol: 2, interfaceName: "@Internal Flash /0x08000000/256*008Kg" }] }] },
    async open() {}, async close() {}, async claimInterface() {}, async selectAlternateInterface() {},
    async controlTransferOut(p: USBControlTransferParameters, data: Uint8Array) {
      if (disconnected) throw new Error("disconnected");
      if (p.request === 6) state = 2;
      if (p.request === 1 && p.value === 0) {
        address = new DataView(data.buffer).getUint32(1, true);
        if (data[0] === 0x41) { erased.push(address); memory.fill(255, address - FLASH_BASE, address - FLASH_BASE + 8192); }
        state = 5;
      } else if (p.request === 1 && data.length) {
        const offset = address - FLASH_BASE + (p.value - 2) * 1024;
        writes.push(offset); memory.set(data, offset); state = 5;
      }
      return { status: "ok", bytesWritten: data.length };
    },
    async controlTransferIn(p: USBControlTransferParameters, n: number) {
      if (disconnected) throw new Error("disconnected");
      const b = new Uint8Array(n);
      if (p.request === 3) b[4] = state;
      else { b.set(memory.slice(address - FLASH_BASE + (p.value - 2) * 1024, address - FLASH_BASE + (p.value - 2) * 1024 + n)); if (corrupt) b[0] ^= 1; }
      return { status: "ok", data: new DataView(b.buffer) };
    },
  } as unknown as USBDevice;
  return { device, writes, erased, memory, corrupt: () => { corrupt = true; }, disconnect: () => { disconnected = true; } };
}
describe("release validation", () => {
  it("checks digest, size, clean identity, revision and vector table", async () => {
    const { image, release } = await fixture();
    await verifyImage(release, image.buffer);
    expect(compatible(release, "v1.0-C1")).toBe(true);
    expect(compatible(release, "v1.0-C2")).toBe(false);
    expect(() => validateRelease({ ...release, dirty: 1 })).toThrow();
    expect(() => validateRelease({ ...release, image: "https://untrusted.invalid/file" })).toThrow();
    await expect(verifyImage(release, image.buffer.slice(1))).rejects.toThrow("size");
    image[100] ^= 1;
    await expect(verifyImage(release, image.buffer)).rejects.toThrow("checksum");
  });
  it("derives ROM identity without a private registry", () => {
    expect(dfuSerial("000000010002000000000003")).toBe("000000040002");
    expect(() => dfuSerial("unknown")).toThrow();
  });
});
describe("DFU bounds and verification", () => {
  it("rejects wrong board identity before opening or erasing", async () => {
    const f = fakeDevice(); await expect(new Dfu(f.device, "WRONG").open()).rejects.toThrow("not the ROTEM");
    expect(f.erased).toEqual([]);
  });
  it("rejects unexpected memory layout", async () => {
    const f = fakeDevice(); Object.defineProperty(f.device, "configuration", { value: { interfaces: [] } });
    await expect(new Dfu(f.device, "000000040002").open()).rejects.toThrow("memory layout");
  });
  it("backs up without writes; erases only required pages and verifies padding", async () => {
    const f = fakeDevice(), dfu = new Dfu(f.device, "000000040002"); await dfu.open();
    const backup = await dfu.read(8192, () => {}); expect(backup[0]).toBe(0x55); expect(f.erased).toEqual([]);
    const { image } = await fixture(); await dfu.write(image, () => {});
    expect(f.erased).toEqual([FLASH_BASE]); expect(f.writes).toEqual([0, 1024]);
    expect(f.memory[image.length]).toBe(255); expect(f.memory[8192]).toBe(0x55);
  });
  it("fails closed on corrupted readback", async () => {
    const f = fakeDevice(), dfu = new Dfu(f.device, "000000040002"); await dfu.open(); f.corrupt();
    await expect(dfu.write((await fixture()).image, () => {})).rejects.toThrow("Readback mismatch");
  });
  it("does not write after a disconnect or outside application bounds", async () => {
    const f = fakeDevice(), dfu = new Dfu(f.device, "000000040002"); await dfu.open();
    await expect(dfu.write(new Uint8Array(MAX_IMAGE + 1), () => {})).rejects.toThrow("size");
    f.disconnect(); await expect(dfu.write((await fixture()).image, () => {})).rejects.toThrow("disconnected");
    expect(f.writes).toEqual([]);
  });
});
