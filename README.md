# ROTEM

Motion sensing you can inspect, build on, and learn from.

ROTEM is SAPPHIFY's experimental robotics sensor platform. This repository contains the firmware, browser workbench, implemented protocol and reproducible software checks. **Wire 0.6 is the current implementation. The old 0.9 specification is a future design, not a compatible device API.**

[Product](https://store.sapphify.com/rotem) · [Documentation](https://docs.sapphify.com/rotem/) · [Studio](https://studio.sapphify.com) · [Java SDK](https://github.com/SapphifyRobotics/sapphify-lib)

## Try the workbench

Open Studio in a browser with Web Serial, then choose **Connect** and select your board. No device is opened automatically. Inspect INFO and GET before changing settings. Apply changes first; Save writes them to flash and waits for the board's readback. Reboot and read again to verify persistence.

For local development:

```sh
cd studio
npm ci
npm run dev
# Optional local USB bridge, in a second terminal:
npm run hub
```

The bridge binds to 127.0.0.1 and accepts same-origin browser requests. Use its local page when using the bridge. Browser measurements and software demonstrations are explicitly separate.

## Build and test

```sh
python3 tools/check_public.py
cc -Wall -Werror -Ifirmware/app tests/trial_vectors.c -lm -o /tmp/rotem-vectors
/tmp/rotem-vectors
cd studio && npm ci && npm run typecheck && npm test && npm run build
# From repository root, with the pinned ARM toolchain:
ARM_GCC_BIN=/path/to/arm-none-eabi/bin bash firmware/app/build.sh
```

Build from a committed tree. Firmware embeds the commit and dirty state. Vendor source hashes and licenses are preserved in `firmware/vendor`; toolchain details are in `firmware/firmware.json`.

## What's here

| Directory | Responsibility |
| --- | --- |
| firmware/app | STM32U575 firmware, configuration, fusion and CAN |
| firmware/vendor | Third-party source and original licenses |
| studio | Browser interface and optional loopback USB bridge |
| protocol | Implemented USB and CAN wire 0.6 |
| tests | Firmware-generated conformance vectors and policy tests |
| tools | Publication checks and firmware preflight |

## Experimental means experimental

Firmware 0.6.4 and Studio 0.9.0 are software-tested candidates. They have **not** been qualified together on hardware. Earlier two-board tests passed at 125/250 kbps; 500 kbps and 1 Mbps remain unresolved. A passing build is not proof of working robot integration. Systemcore physical testing is pending. The initial C1 units have reversed RGB LEDs; no LED or enclosure screw qualification is claimed.

Read [compatibility](COMPATIBILITY.md) and the [bench checklist](docs/BENCH.md) before installing. Use a disconnected test rig, not an enabled robot.

## Open software, reference schematics

Original code is MIT licensed; vendor licenses remain in force. Revision-specific schematic PDFs are provided separately for viewing and learning. PCB layouts, Gerbers, manufacturing models, private device records and factory history are not part of this repository. Public display models are simplified visual assets, not manufacturing files. See [asset terms](ASSETS.md).

## Build it with us

Start with a reproducible issue, a small improvement or a documentation correction. See [contributing](CONTRIBUTING.md), [security](SECURITY.md) and [community guidelines](CODE_OF_CONDUCT.md). Please include software versions, hardware revision, expected behavior and anonymized logs.
