# Two-board qualification

Record date, operator, hardware revisions, firmware commit/checksum, Studio version, SDK version, supply, cable length and termination. Keep unit serials in private records. Never report planned tests as passes.

1. With power off, verify pin mapping and about 60 ohms across the terminated CAN pair. Connect CANH to CANH, CANL to CANL and ground. Do not assume matching wire colors prove pinout. Do not join two power outputs.
2. Connect USB, choose Connect, save INFO/GET/TEST/RAILS. Confirm no startup reset loop or rail fault.
3. Rotate one axis at a time; record signed X/Y/Z, yaw/pitch/roll and return-to-zero behavior. Compare Studio and Java units.
4. Apply settings without Save and reboot; verify they revert. Apply and Save, wait for saved=1, reboot and compare GET. Test invalid commands leave the configuration unchanged.
5. Capture both boards at 125, 250, 500 and 1000 kbps. Record sent/received/lost, TEC/REC/bus-off, latency distribution and a minimum 10-minute run per rate. A loopback test alone does not pass this gate.
6. Disconnect and reconnect CAN/USB while logging health and age. Missing or stale data must not become a valid zero. Record bounded recovery and behavior after retry exhaustion. Explicit CAN STOP must remain stopped.
7. Calibrate stationary gyro and magnetometer away from metal, Save, reboot, verify readback and repeat the axis exercise.
8. Check firmware manifest hardware revision and SHA-256; enter existing STM32 DFU, flash only from a committed known binary using the internal registered-unit tool. Confirm INFO version/commit, configuration and recovery via BOOT/RESET. Do not interrupt flash deliberately without an independently verified recovery method.
9. Build a complete 2026 robot project and the selected 2027 Alpha 7 project. Test on the actual controller before claiming physical compatibility.
10. Repeat installation from public URLs in a clean environment. Prime the official WPILib toolchain separately, install the offline SDK bundle, disable networking and rebuild.

Status for this candidate: all physical steps pending. Store raw measurements privately and publish a redacted result matrix tied to exact commits.
