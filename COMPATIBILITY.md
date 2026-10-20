# Compatibility and qualification

| Component | Version | Evidence | Remaining gate |
| --- | --- | --- | --- |
| Wire protocol | 0.6 | C-generated vectors, Java decoder checks | Two-board end-to-end capture |
| Firmware | 0.6.4 experimental | ARM compile; one C1 flash/readback, short stationary and restart checks (2026-10-19) | Long-duration, thermal, CAN and controller qualification |
| Studio | 0.9.0 experimental | TypeScript, unit tests, static build | Real USB/CAN interaction |
| Java SDK 2026 | 2026.0.0-trial2 | WPILib 2026.2.2 compile and vectors | roboRIO physical integration |
| Java SDK 2027 | 2027.0.0-trial2 | Alpha 7 compile and vectors | Systemcore physical integration |
| Classic CAN | 125/250 kbps | Previous bench evidence only | Repeat with this exact release |
| Classic CAN | 500/1000 kbps | Previous failures unresolved | Physical measurement and clean repeat |

No stable release or physical 2027 support is declared. C++ and wire 0.9 are future work. Do not mix the old draft SDK with wire 0.6 firmware.
