export const REPOSITORY = "SapphifyRobotics/rotem-software";
export const FLASH_BASE = 0x08000000;
// Conservative application ceiling, below either supported flash size's settings page.
export const MAX_IMAGE = 1024 * 1024 - 8192;
export interface Release {
  version: string; commit: string; sha256: string; dirty: number;
  tag: string; channel: "experimental" | "stable"; hardware_revisions: string[];
  bytes: number; image: string; physical_tests: string;
}
export function validateRelease(r: Release): void {
  if (!r || !/^\d+\.\d+\.\d+$/.test(r.version) || !/^[a-f0-9]{7,40}$/.test(r.commit)
    || !/^[a-f0-9]{64}$/.test(r.sha256) || r.dirty !== 0
    || !/^v[\w.-]+$/.test(r.tag) || !["stable", "experimental"].includes(r.channel)
    || !Array.isArray(r.hardware_revisions) || !r.hardware_revisions.every(x => typeof x === "string")
    || !Number.isInteger(r.bytes) || r.bytes < 8 || r.bytes > MAX_IMAGE
    || r.image !== `/firmware/${r.sha256}.bin`) throw new Error("Invalid release manifest. Nothing will be written.");
}
export function compatible(r: Release, board: string) {
  return board === "v1.0-C1" && r.hardware_revisions.includes("C1");
}
export async function verifyImage(r: Release, image: ArrayBuffer) {
  validateRelease(r);
  if (image.byteLength !== r.bytes) throw new Error("Firmware size mismatch.");
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", image)), b => b.toString(16).padStart(2, "0")).join("");
  if (digest !== r.sha256) throw new Error("Firmware checksum mismatch.");
  const view = new DataView(image), pc = view.getUint32(4, true);
  if (view.getUint32(0, true) !== 0x20030000 || !(pc & 1) || pc < FLASH_BASE || pc >= FLASH_BASE + image.byteLength)
    throw new Error("Invalid C1 application vector table.");
}
export function dfuSerial(uid: string) {
  if (!/^[a-f0-9]{24}$/i.test(uid)) throw new Error("Board identity unavailable. Reconnect before updating.");
  const sum = (parseInt(uid.slice(0, 8), 16) + parseInt(uid.slice(16), 16)) >>> 0;
  return sum.toString(16).padStart(8, "0").toUpperCase() + uid.slice(8, 12).toUpperCase();
}
export async function catalog(): Promise<Release[]> {
  const response = await fetch("/firmware/catalog.json", { cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("Release catalog unavailable. Please retry later.");
  const releases: Release[] = await response.json();
  if (!Array.isArray(releases) || releases.length > 50) throw new Error("Invalid release catalog.");
  releases.forEach(validateRelease);
  return releases;
}
