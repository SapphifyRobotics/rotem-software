# ROTEM Studio 0.9.0

[Open Studio](https://studio.sapphify.com) or run `npm ci && npm run dev`. Choose Connect to grant access to a device. No serial connection is initiated by the public page before that action.

`npm start` builds and serves the optional loopback hub at http://127.0.0.1:4747. The hub accepts only same-origin requests and connects after a local browser client requests it. If multiple ROTEM boards are attached, start it with `node server/hub.mjs --device /dev/your-selected-port`; it must not guess which board to configure.

Simple mode offers measurements and basic settings. Advanced mode adds live sensors, filter experiments, calibration, CAN and firmware recovery guidance. Apply changes in RAM, then Save for flash persistence; readback must match. Reboot verification remains a physical bench step.

Public 3D assets are simplified illustrations. A Canvas compatibility model follows orientation without WebGL; numeric readings do not require WebGL. Firmware fusion and browser filter experiments are labelled separately. Magnetometer heading is not qualified until calibration and axes are verified on hardware.

Run `npm run typecheck`, `npm test` and `npm run build` before publishing. Manufacturing CAD, private recordings and unit identifiers are not included.

## Firmware updates

The Firmware panel reads version and commit from INFO, checks GitHub releases, and installs only reviewed images mirrored in `public/firmware/catalog.json`. Stable is the default channel; current candidates are experimental.

- `src/firmware/release.ts`: manifest, hardware, vector and checksum validation.
- `src/firmware/dfu.ts`: bounded STM32 DfuSe transport, identity check, backup, page erase, write and readback.
- `src/firmware/controller.ts`: explicit user actions and post-reconnect INFO verification.
- `tools/package_browser_release.py` at repository root: import a published release into the static catalog. Build and deploy Studio after reviewing the output.

Browser flashing is experimental and has not completed physical qualification. Automated tests do not replace a board-level update/recovery test. No automatic rollback, option-byte writes or mass erase. The local hub does not expose a flashing API. The browser must receive permission for the ROM DFU device separately. Device identifiers stay local.
