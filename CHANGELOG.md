# Changelog

## Firmware 0.6.4 / Studio 0.9.0 — experimental, 2026-10-19

- Extract original software from the private product workspace without its history or unit records.
- Keep implemented wire 0.6; distinguish the incompatible draft 0.9.
- Add bounded CAN bus-off recovery policy, malformed frame rejection and repeat-save protection.
- Studio uses explicit connection, board acknowledgements, malformed sample rejection and a same-origin loopback bridge.
- Add CAN controls, firmware recovery guidance and approved simplified visual models.
- Preserve configuration format; settings require explicit Save and reboot verification.

Not flashed or physically qualified. Higher-rate CAN, persistence, recovery and Systemcore remain open bench gates.
