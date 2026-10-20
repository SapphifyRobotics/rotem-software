# Changelog

## Firmware 0.6.4 / Studio 0.9.0 — experimental, 2026-10-19

- Extract original software from the private product workspace without its history or unit records.
- Keep implemented wire 0.6; distinguish the incompatible draft 0.9.
- Add bounded CAN bus-off recovery policy, malformed frame rejection and repeat-save protection.
- Studio uses explicit connection, board acknowledgements, malformed sample rejection and a same-origin loopback bridge.
- Add CAN controls, firmware recovery guidance and approved simplified visual models.
- Preserve configuration format; settings require explicit Save and reboot verification.

Not flashed or physically qualified. Higher-rate CAN, persistence, recovery and Systemcore remain open bench gates.

## 2026-10-19 bench follow-up

- Firmware 0.6.4 clean build 625e31e flashed and verified on one C1 unit; settings retained, gyro bias and magnetic coefficients saved/read back and checked after ROM-mediated restart.
- Short stationary recordings and manual movement/return-to-rest passed; long-run drift cause remains unresolved. No new CAN or absolute heading qualification.
- Studio now bases heading conversion and magnetic-mode text on the selected fusion source, rather than the app filter preference when displaying board fusion.
- Bench details: https://docs.sapphify.com/rotem/releases/#stationary-bench-check-october-19-2026 .
