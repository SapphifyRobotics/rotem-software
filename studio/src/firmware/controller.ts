import { Dfu } from "./dfu";
import { catalog, compatible, dfuSerial, MAX_IMAGE, REPOSITORY, verifyImage, type Release } from "./release";
import type { Link } from "../link";

export function firmwarePanel(getConnection: () => { info: Record<string, string> | null; link: Link | null }) {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const message = el("fw-message"), current = el("fw-current"), details = el("fw-release");
  const check = el<HTMLButtonElement>("fw-check"), prepare = el<HTMLButtonElement>("fw-prepare");
  const pair = el<HTMLButtonElement>("fw-pair"), flash = el<HTMLButtonElement>("fw-flash"), reset = el<HTMLButtonElement>("fw-reset");
  const experimental = el<HTMLInputElement>("fw-experimental"), progress = el<HTMLProgressElement>("fw-progress");
  let release: Release | null = null, image: ArrayBuffer | null = null, dfu: Dfu | null = null;
  let identity: Record<string, string> | null = null, pending = false, busy = false;
  const say = (s: string) => { message.textContent = s; };
  const stage = (s: string, f: number) => { progress.hidden = false; progress.value = f; say(s); };
  const save = (data: BlobPart, name: string) => {
    const url = URL.createObjectURL(new Blob([data]));
    const a = document.createElement("a"); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
  const guard = async (action: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    check.disabled = prepare.disabled = pair.disabled = flash.disabled = reset.disabled = experimental.disabled = true;
    try { await action(); } catch (e) {
      say(`${e instanceof Error ? e.message : e} No success is assumed. If the board is in DFU, use the recovery guide or reconnect it and start again.`);
      if (dfu) { await dfu.close().catch(() => {}); dfu = null; }
      flash.disabled = true;
    } finally {
      busy = false; check.disabled = pending; experimental.disabled = pending; reset.disabled = false;
      pair.disabled = !pending || !!dfu || el("fw-phase").textContent === "Reconnect to verify";
      flash.disabled = !dfu || !image;
      refresh();
    }
  };
  function refresh() {
    const { info, link } = getConnection();
    current.textContent = info && link ? `Installed: ${info.fw} · build ${info.commit ?? "unknown"} · ${info.board}` : "Connect ROTEM to read its installed firmware and board revision.";
    prepare.disabled = busy || pending || !release || !link || !info || !compatible(release, info.board)
      || (release.channel === "experimental" && !experimental.checked) || !("usb" in navigator);
    if (pending && info && link && identity && release && info.uid === identity.uid
      && info.fw === release.version && info.commit === release.commit) {
      // Only the post-flash verification phase may finish from INFO.
      if (el("fw-phase").textContent === "Reconnect to verify") {
        pending = false; identity = null; check.disabled = false; experimental.disabled = false; pair.disabled = true;
        say("Update verified: flash readback passed and the same board reports the expected version and build. Recheck your settings and calibration.");
        el("fw-phase").textContent = "Verified";
      }
    }
  }
  reset.onclick = () => void guard(async () => {
    if (dfu) await dfu.close().catch(() => {});
    dfu = null; pending = false; identity = null; image = null;
    el("fw-phase").textContent = "Prepare your update";
    say("Update session ended. If firmware was only partly written, stay in DFU and use the recovery guide. Otherwise reconnect ROTEM before starting again.");
  });
  experimental.onchange = () => { release = null; image = null; details.textContent = "Check releases for the selected channel."; refresh(); };
  check.onclick = () => void guard(async () => {
    release = null; image = null;
    say("Checking GitHub and the verified firmware catalog…");
    const releases = await catalog();
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=30`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`GitHub check unavailable (${response.status}). No latest-version claim can be made. Retry later.`);
    const remote = await response.json();
    if (!Array.isArray(remote)) throw new Error("Unexpected GitHub response.");
    const latest = remote.filter(r => !r.draft && (experimental.checked || !r.prerelease))
      .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
    if (!latest) { details.textContent = "No stable firmware release is published yet."; say("Enable experimental releases only if you are evaluating a prototype."); return; }
    const found = releases.find(r => r.tag === latest.tag_name);
    if (!found) throw new Error("A newer GitHub release is not yet available in Studio's verified catalog. Review it on GitHub; browser installation is blocked until it is packaged.");
    const asset = latest.assets?.find((a: { name: string }) => a.name === "rotem-app.bin");
    if (asset?.digest !== `sha256:${found.sha256}` || asset.size !== found.bytes
      || latest.prerelease !== (found.channel === "experimental"))
      throw new Error("GitHub assets or release channel changed since review. Installation blocked; refresh the verified catalog first.");
    release = found;
    details.textContent = `${found.version} · ${found.channel} · build ${found.commit}\n${found.physical_tests}\nSHA-256: ${found.sha256}`;
    const { info } = getConnection();
    say(info?.fw === found.version && info.commit === found.commit ? "This board already has the latest published build. Reinstallation is optional." : "Release found. Connect your board, export settings, then prepare the update. Browser flashing is experimental and not yet hardware-qualified.");
  });
  prepare.onclick = () => void guard(async () => {
    const { info, link } = getConnection();
    if (!release || !info || !link || !compatible(release, info.board)) throw new Error("Connect a compatible C1 board first.");
    if (release.channel === "experimental" && !experimental.checked) throw new Error("Experimental channel is not enabled.");
    dfuSerial(info.uid);
    say("Downloading and verifying the release image…");
    const r = await fetch(release.image, { cache: "no-store", signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error("Firmware download failed.");
    image = await r.arrayBuffer(); await verifyImage(release, image);
    if (!confirm(`Install experimental browser update ${release.version}, build ${release.commit}? Export your settings first. Keep USB connected. The next step asks you to select this board in DFU mode. No flash is erased until you click Write and verify.`)) return;
    identity = { ...info }; pending = true;
    await link.send("BOOT");
    await new Promise(r => setTimeout(r, 800));
    await link.close();
    // Explicit close suppresses HubLink's socket callback; clear the app connection
    // as well so reconnect never targets a closed WebSocket after manifestation.
    link.onClose("Released connection for firmware update");
    el("fw-phase").textContent = "Select the same board in DFU";
    say("Select STM32 BOOTLOADER below. Studio checks its identity against the connected ROTEM before reading or writing.");
  });
  pair.onclick = () => void guard(async () => {
    if (!identity || !image || !release) throw new Error("Prepare the update first.");
    // requestDevice remains directly inside the user's click gesture.
    const device = await navigator.usb.requestDevice({ filters: [{ vendorId: 0x0483, productId: 0xdf11 }] });
    dfu = new Dfu(device, dfuSerial(identity.uid)); await dfu.open();
    const backup = await dfu.read(MAX_IMAGE, f => stage("Reading application backup before any erase", f));
    save(backup.buffer as ArrayBuffer, `rotem-application-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.bin`);
    el("fw-phase").textContent = "Backup downloaded";
    say("Application backup download requested. Confirm it is saved before continuing; keep it with your settings export. It excludes the settings page. Click Write and verify when ready; do not unplug during the write.");
  });
  flash.onclick = () => void guard(async () => {
    if (!dfu || !image || !release) throw new Error("Prepare and select your board first.");
    await verifyImage(release, image);
    el("fw-phase").textContent = "Writing and verifying";
    await dfu.write(new Uint8Array(image), stage);
    await dfu.restart(); await dfu.close().catch(() => {}); dfu = null;
    el("fw-phase").textContent = "Reconnect to verify";
    say("Flash readback passed. Click Connect to reconnect ROTEM. The update is not complete until INFO confirms the expected version and build.");
  });
  window.addEventListener("beforeunload", e => { if (busy || pending) { e.preventDefault(); e.returnValue = ""; } });
  if (!("usb" in navigator)) say("This browser has no WebUSB. Version detection still works through a supported connection. Use desktop Chrome/Edge or the local DFU recovery guide to flash.");
  refresh();
  return { refresh };
}
