# ROTEM — interfaces

## USB link (0.6.x protocol, Studio 0.9.0 experimental)

USB full speed, CDC ACM, VID:PID `cafe:4010` (prototype VID), product string `ROTEM`, serial number = MCU UID.
Baud rate is nominal. ASCII, one command per line (`\n`), one or more reply lines.

| command | reply |
|---|---|
| `PING` | `PONG ROTEM` |
| `INFO` | `INFO fw= commit= board= uid= imu= imu_id= mag= mag_id= accel_fs_g= gyro_fs_dps= imu_odr_hz= mag_enabled= mag_hz= rate_hz= uptime_ms=` |
| `RAILS` | `RAILS OK vdda_mv= rail5_mv= vin_mv= usb=0|1 adc_err=` (`RAILS ERR` on ADC failure); vin is the robot supply after the reverse-polarity FET |
| `DIAG` | clock source and frequency, SPI/I2C registers and error counts, data-ready pulse count |
| `CAN START <125|250|500|1000> [FD]` | starts CAN, crystal clock straight into FDCAN; reply `CAN state=on kbps= clock= tx= rx= echoed= bad= tx_full= tec= rec= lec= bus_off= passive= recovery_attempts= recovery_failed=` |
| `CAN TEST <n>` | sends n PING frames (ID 0x321) one at a time, each answered by any board with an ECHO (0x322); ends with `CANTEST n= ok= lost= rtt_min_us= rtt_avg_us= rtt_max_us=` |
| `CAN STATUS` / `CAN STOP` / `CAN IDLE` | counters / inactive (C1 silent, D0 standby) / bus-idle probe (`CANIDLE samples= dominant= edges=`) |
| `TEST` | `TEST <name> PASS|FAIL <detail>` per check (imu_id, imu_config, accel_1g, imu_temp, mag_id, vdda, rail5), then `TEST done` |
| `STREAM ON` / `STREAM OFF` | `OK stream on` / `OK stream off`; stream also stops when the host closes the port |
| `GET` | `CFG accel_fs_g= gyro_fs_dps= odr_hz= rate_hz= mag= mag_hz= led= gb=x,y,z mo=x,y,z ms=x,y,z saved=0|1` |
| `SET key=value` | change one setting live, reply `CFG ...`; `ERR bad setting` or `ERR rate_hz above odr_hz` |
| `SAVE` | write the settings to flash (last 8 KiB page, CRC-checked): `OK saved` then `CFG ...`; `ERR save n` |
| `LOAD` / `DEFAULTS` | reload from flash / factory values (not saved until `SAVE`), reply `CFG ...` |
| `LED xx` | hex mask 00..3F: LED1 R G B, LED2 R G B; `OK led xx` (also becomes the `led` setting) |
| `BOOT` | `OK rebooting to ROM DFU`, then the ROM bootloader |
| anything else | `ERR ...` |

Stream line, at `rate_hz`:

```
S t=<board ms> n=<seq> a=<ax>,<ay>,<az> g=<gx>,<gy>,<gz> m=<mx>,<my>,<mz> mo=<ox>,<oy>,<oz> mn=<mag seq> temp=<raw> ie=<imu errors> me=<mag errors> mc=<last mag error> ov=<missed data-ready> src=drdy|timer q=<w,x,y,z x10000> ypr=<yaw,pitch,roll x100> cy=<continuous yaw x100> fb=<learned gyro bias, milli-deg/s> fl=<flags>
```

| field | unit |
|---|---|
| a | ICM-45686 raw: g = raw × accel_fs_g / 32768 |
| g | ICM-45686 raw: °/s = raw × gyro_fs_dps / 32768 |
| m | MMC5983MA field, sensor axes, 16384 LSB/gauss: half the difference of a SET and a RESET measurement, so the bridge offset is removed; updated at `mag_hz`, `mn` counts updates; zero when `mag=0` |
| mo | the bridge offset that pair removed (half their sum), counts; diagnostic |
| temp | ICM-45686: °C = raw/128 + 25 |
| n | increments by one per line; a gap is a lost line |

Axes are each sensor's own. The board frame (x right, y toward the USB edge, z out of the component side) is assumed
equal to the IMU frame in rotem-studio; the magnetometer-to-IMU transform is not yet verified (SENSOR_PLACEMENT.md).

### Settings

| key | values | default |
|---|---|---|
| accel_fs_g | 2 4 8 16 32 | 4 |
| gyro_fs_dps | 125 250 500 1000 2000 4000 | 500 |
| odr_hz | 25 50 100 200 400 800 (sensor data rate) | 100 |
| rate_hz | 1..200, not above odr_hz (USB stream) | 100 |
| mag, mag_hz | 0/1; 10 20 50 | 1, 20 |
| ma | magnetometer-to-board axis map, index into `MAG_AXES` in `09_software/rotem-studio/src/magaxes.ts`, 0..47 | 0 = datasheet (x, y, -z) |
| led | 0..63, LEDs at power-up | 0 |
| gb | gyro bias, milli-°/s, subtracted by the host | 0,0,0 |
| mo, ms | magnetometer offset (counts) and scale (ppm, 0 = 1.0), applied by the host | 0, 0 |

Calibration values are stored on the board so every host uses the same ones; the firmware does not apply them.

## Optional-load policy (firmware 0.6.2 candidate; not flashed)

Sampling and fusion start normally. RGB outputs and CAN additionally require a valid sampled +5V rail
(4.7 V to enable; below 4.5 V disables) and, whenever VBUS is detected, a configured USB connection outside
suspend. ADC errors inhibit these optional loads. The rail is sampled at startup, on VBUS changes and about
every 100 ms; this adds ADC polling latency and is not fast hardware undervoltage protection.

Saved LED values remain requested while outputs are inhibited. Automatic CAN and an already accepted manual
START resume with their requested settings after a temporary inhibit; STOP or IDLE clears that intent. While
inhibited, CAN commands other than STOP/STATUS return `ERR USB power budget not granted` (the same reply also
covers an invalid/low rail). A rejected START is not queued. `LED` updates the requested mask without overriding
the power policy. No settings-format migration is needed.

With robot and USB both connected, an unconfigured/suspended USB host still inhibits optional loads because
MUX_ST is not connected to the MCU. Robot-only operation becomes eligible after the rail passes its threshold.
The USB configuration requests 200 mA; actual startup, configured and suspend consumption remain unmeasured.

## rotem-hub

`09_software/rotem-studio/server/hub.mjs` owns the serial port and serves the app and a WebSocket at `/ws` on one
port (default 4747). Board lines go to every client; client lines go to the board. It streams while any client is
connected and drops clients' `STREAM` commands. It adds `HUB device=<path|none> clients=<n>` lines and `GET /hub`.

## Axes

Board frame: x toward the right edge, y toward the USB edge, z out of the component side.

- ICM-45686 (U1, pin 1 top-left, rotation 0): its datasheet frame (Figure 13) equals the board frame.
- MMC5983MA (U2): pin 1 sits bottom-left, the part turned 180 degrees from its datasheet drawing, whose +Z
  points into the package. Board = (mx, my, -mz): index 0 of `MAG_AXES`. The calibration checks this by rotation
  (the field must turn against the gyro as a fixed vector does, and dip downward north of the magnetic equator)
  and stores the map it finds as `ma`.

## Sampling (firmware 0.5.0)

The core runs at 160 MHz from the 16 MHz crystal (HSI16 fallback). The ICM-45686 is read over the SPI1
peripheral at 10 MHz on its INT1 data-ready pulse (PA8, EXTI8); when `odr_hz` is above `rate_hz`, each stream line
is the mean of `odr_hz / rate_hz` samples. Without data-ready pulses for 100 ms the stream falls back to a timer
(`src=timer`). The MMC5983MA is on the I2C1 peripheral at about 390 kHz. Every SPI read clocks one extra byte and
discards it: the last byte of an SPI1 transfer read back corrupted on this board (found 2026-10-04).

## Independent operation (firmware 0.6.0)

From power-up, with or without a host, the board samples the IMU on data-ready, runs the attitude filter
(`05_firmware/app/fusion.c`, the studio's MEKF in float: zero-rate update, heading hold while still, gravity
corrections kept off the heading, optional magnetic heading) with each time step taken from the crystal, keeps a
continuous heading (no wrap at ±180°), and, if `can_auto=1`, starts CAN at `can_kbps` and sends the frames below.
Flags: 1 still, 2 calibrated (2 s of stillness since boot), 4 magnetometer in the fusion, 8 sensor error, 16 USB
present. Commands over USB: `YAW ZERO`, `YAW SET <deg>`, `FUSION RESET`, `BIAS SAVE` (learned bias into `gb`, then
`SAVE`). New settings: `can_kbps` (default 1000), `can_auto` (1), `can_node` (0..63, unique per bus), `yaw_ms` (10),
`fast_ms` (20), `mag_fusion` (0). Settings saved by firmware 0.2–0.5 are migrated, calibration kept.

## CAN frames (firmware 0.6.0)

29-bit FRC identifiers: device type 4 (gyro sensor), manufacturer 8 ("team use", provisional until ROTEM has a FIRST
vendor ID), 10-bit API, 6-bit device number = `can_node`. ID = 0x04080000 | api << 6 | node. Classic CAN, 8 bytes,
little-endian.

| API | period | bytes |
|---|---|---|
| 0x000 yaw | `yaw_ms` (10 ms) | float32 continuous yaw, degrees, counter-clockwise positive · int16 yaw rate, 0.01 °/s · flags · sequence |
| 0x001 pitch/roll | `fast_ms` (20 ms) | int16 pitch 0.01° · int16 roll 0.01° · int16 IMU temperature 0.01 °C · flags · sequence |
| 0x002 quaternion | `fast_ms` | 4 × int16 w, x, y, z, ×32767 |
| 0x003 acceleration | `fast_ms` | 3 × int16 mg (board frame) · flags · sequence |
| 0x004 rates | `fast_ms` | 3 × int16, 1/8 °/s, bias removed · flags · sequence |
| 0x005 status | 1 s | uint16 uptime s · IMU errors · magnetometer errors · flags · firmware minor · 0 · sequence |
| 0x010 set yaw (to the board) | — | float32 degrees |
| 0x011 zero yaw (to the board) | — | any |

At 1 Mbit/s the default set is about 350 frames/s, roughly 4–5 % of the bus.
