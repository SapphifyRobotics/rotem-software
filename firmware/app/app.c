#include "trial_protocol.h"
/* ROTEM app firmware: line protocol over USB CDC, documented in
 * 03_documentation/interfaces.md. Commands in, replies and stream lines out. */
#include <string.h>
#include "stm32u5xx.h"
#include "tusb.h"
#include "sensors.h"
#include "config.h"
#include "can.h"
#include "fusion.h"
#include "power_budget.h"
#include <math.h>

#define FW_VERSION "0.6.4"
#define BOARD_REV "v1.0-C1"
#ifndef FW_COMMIT
#define FW_COMMIT "unknown"
#define FW_DIRTY 1
#endif

static fusion_t fus;
static void set_yaw(float deg);
static void fusion_restart(void);

/* Logical mask bits: LED1 R/G/B then LED2 R/G/B. Logical pin mapping; fabricated C1 LED orientation is defective. */
static const unsigned pins[6] = {1, 2, 10, 12, 13, 14};
#define LED_GPIO_MASK 0x7406u
static unsigned active_mask, requested_mask;
static bool optional_loads_ready, rail_ready, rail_sampled, previous_vbus;
static uint32_t rail_checked_ms;
static bool requested_can, requested_can_fd, requested_can_hse;
static unsigned requested_can_kbps;

static char input[48];
static unsigned used;
static bool overflow;
static char out[1024];
static unsigned out_len;

static bool streaming, stream_fresh;
static uint32_t next_sample, seq, imu_errors, mag_errors;
static uint32_t next_mag;
static mag_sample_t last_mag;
static uint32_t mag_seq, mag_last_error;

static uint32_t boot_at;
static bool boot_pending;
static volatile uint32_t boot_request __attribute__((section(".noinit")));
#define BOOT_MAGIC 0x524F544Du

__attribute__((naked, noreturn)) static void enter_rom(uint32_t vector __attribute__((unused)))
{
    __asm volatile("ldr r1, [r0]\nldr r2, [r0, #4]\nmovs r3, #0\n"
                   "msr control, r3\nmsr msp, r1\ndsb\nisb\ncpsie i\nbx r2");
}

void boot_recovery_check(void)
{
    if (boot_request != BOOT_MAGIC) return;
    boot_request = 0;
    /* Read-only selection of the verified ROM boot address, no option writes. */
    uint32_t vector = FLASH->NSBOOTADD1R & ~0x7fu;
    if (vector != 0x0bf90000u) return;
    const uint32_t *table = (const uint32_t *)vector;
    if (table[0] < 0x20000000u || table[0] > 0x200c0000u ||
        !(table[1] & 1u) || table[1] < vector || table[1] >= 0x0bfa0000u) return;
    __disable_irq();
    SysTick->CTRL = 0;
    SCB->VTOR = vector;
    enter_rom(vector);
}

static void set_leds(unsigned mask)
{
    unsigned low = 0;
    requested_mask = mask & 63u;
    active_mask = optional_loads_ready ? requested_mask : 0;
    for (unsigned i = 0; i < 6; ++i)
        if (active_mask & (1u << i)) low |= 1u << pins[i];
    GPIOB->BSRR = LED_GPIO_MASK;
    GPIOB->BSRR = low << 16;
}

/* Output: everything goes through one buffer drained into the CDC FIFO. */
uint32_t backpressure; /* lines delayed because the USB output buffer was full */
static bool room(unsigned n) { if (out_len + n < sizeof(out)) return true; ++backpressure; return false; }
static void put(const char *s)
{
    while (*s && out_len < sizeof(out)-1) out[out_len++] = *s++;
}
static void num(int32_t v)
{
    char t[12]; unsigned n = 0; uint32_t u = v < 0 ? (uint32_t)-v : (uint32_t)v;
    do { t[n++] = (char)('0' + u % 10); u /= 10; } while (u);
    if (v < 0) t[n++] = '-';
    while (n && out_len < sizeof(out)-1) out[out_len++] = t[--n];
}
static void hex(uint32_t value, int digits)
{
    const char *d = "0123456789ABCDEF";
    for (int shift = 4*(digits-1); shift >= 0; shift -= 4)
        if (out_len < sizeof(out)-1) out[out_len++] = d[(value >> shift) & 15u];
}
static void kv(const char *key, int32_t v) { put(" "); put(key); put("="); num(v); }

static void uid(void)
{
    const uint32_t *u = (const uint32_t *)UID_BASE;
    hex(u[2], 8); hex(u[1], 8); hex(u[0], 8);
}

static void info(void)
{
    imu_sample_t i; read_imu(&i);
    mag_sample_t m; if (!streaming) read_mag(&m); else m = last_mag;
    put("INFO fw=" FW_VERSION " commit=" FW_COMMIT); put(FW_DIRTY ? "+dirty" : ""); put(" board=" BOARD_REV " uid="); uid();
    put(" imu=ICM-45686 imu_id="); hex(i.id, 2);
    put(" mag=MMC5983MA mag_id="); hex(m.id ? m.id : 0x30, 2);
    kv("accel_fs_g", config.accel_fs_g); kv("gyro_fs_dps", config.gyro_fs_dps);
    kv("imu_odr_hz", config.odr_hz); kv("mag_enabled", config.mag_enabled); put(" mag_hz=");
    num((int32_t)config.mag_hz);
    kv("rate_hz", config.rate_hz);
    kv("uptime_ms", (int32_t)tusb_time_millis_api());
    put("\n");
}

static void rails(void)
{
    extern int read_rails(uint32_t *,uint32_t *,uint32_t *,uint32_t *,uint32_t *);
    uint32_t sense=0, ref=0, cal=0, vdda=0, rail5=0;
    int err = read_rails(&sense,&ref,&cal,&vdda,&rail5);
    extern int read_vin(uint32_t, uint32_t *); extern int usb_present(void);
    uint32_t vin = 0; if (!err) read_vin(vdda, &vin);
    put(err ? "RAILS ERR" : "RAILS OK");
    kv("vdda_mv", (int32_t)vdda); kv("rail5_mv", (int32_t)rail5); kv("vin_mv", (int32_t)vin); kv("usb", usb_present()); kv("adc_err", err);
    put("\n");
}

static void selftest(void)
{
    extern int read_rails(uint32_t *,uint32_t *,uint32_t *,uint32_t *,uint32_t *);
    imu_sample_t i; read_imu(&i);
    put("TEST imu_id "); put(i.id == 0xe9 ? "PASS" : "FAIL"); put("\n");
    put("TEST imu_config "); put(!i.error ? "PASS" : "FAIL"); put("\n");
    int32_t a2 = 0;
    /* |a| in 1/128 g: 1 g = 32768/fs LSB, so divide by 256/fs; 128^2 = 16384 at rest. */
    int32_t div = 256 / config.accel_fs_g;
    for (int k = 0; k < 3; ++k) a2 += (i.accel[k]/div)*(i.accel[k]/div);
    put("TEST accel_1g "); put(a2 > 16384*6/10 && a2 < 16384*14/10 ? "PASS" : "FAIL");
    kv("mag2", a2); put("\n");
    int32_t t_c = i.temp / 128 + 25;
    put("TEST imu_temp "); put(t_c > -20 && t_c < 85 ? "PASS" : "FAIL"); kv("c", t_c); put("\n");
    mag_sample_t m; read_mag(&m);
    put("TEST mag_id "); put(!m.error && m.id == 0x30 ? "PASS" : "FAIL"); kv("err", (int32_t)m.error); put("\n");
    uint32_t sense=0, ref=0, cal=0, vdda=0, rail5=0;
    int err = read_rails(&sense,&ref,&cal,&vdda,&rail5);
    put("TEST vdda "); put(!err && vdda > 3100 && vdda < 3500 ? "PASS" : "FAIL"); kv("mv", (int32_t)vdda); put("\n");
    put("TEST rail5 "); put(!err && rail5 > 4500 && rail5 < 5500 ? "PASS" : "FAIL"); kv("mv", (int32_t)rail5); put("\n");
    put("TEST done\n");
}


static void apply_config(void)
{
    sensors_reconfigure();
    set_leds(config.led_mask);
    next_sample = next_mag = tusb_time_millis_api();
}

static void cfg_line(void)
{
    put("CFG");
    kv("accel_fs_g", config.accel_fs_g); kv("gyro_fs_dps", config.gyro_fs_dps);
    kv("odr_hz", config.odr_hz); kv("rate_hz", config.rate_hz);
    kv("mag", config.mag_enabled); kv("mag_hz", config.mag_hz); kv("ma", config.mag_axes); kv("led", config.led_mask);
    put(" gb="); num(config.gyro_bias_mdps[0]); put(","); num(config.gyro_bias_mdps[1]); put(","); num(config.gyro_bias_mdps[2]);
    put(" mo="); num(config.mag_offset_counts[0]); put(","); num(config.mag_offset_counts[1]); put(","); num(config.mag_offset_counts[2]);
    put(" ms="); num(config.mag_scale_ppm[0]); put(","); num(config.mag_scale_ppm[1]); put(","); num(config.mag_scale_ppm[2]);
    kv("can_kbps", config.can_kbps); kv("can_auto", config.can_auto); kv("can_node", config.can_node);
    kv("yaw_ms", config.yaw_period_ms); kv("fast_ms", config.fast_period_ms); kv("mag_fusion", config.mag_fusion);
    kv("saved", config_saved_matches());
    put("\n");
}

static int parse_int(const char **p, int32_t *v)
{
    int neg = 0; int32_t x = 0; const char *s = *p;
    if (*s == '-') { neg = 1; ++s; }
    if (*s < '0' || *s > '9') return -1;
    while (*s >= '0' && *s <= '9') x = x * 10 + (*s++ - '0');
    *v = neg ? -x : x; *p = s; return 0;
}
static int parse_triple(const char *p, int32_t v[3])
{
    for (int k = 0; k < 3; ++k) {
        if (parse_int(&p, &v[k])) return -1;
        if (k < 2 && *p++ != ',') return -1;
    }
    return *p ? -1 : 0;
}

static void set_command(const char *arg)
{
    const char *eq = strchr(arg, '=');
    if (!eq) { put("ERR use SET key=value\n"); return; }
    unsigned klen = (unsigned)(eq - arg); const char *val = eq + 1;
    config_t next = config; int32_t v = 0, t[3];
    int scalar = parse_int(&val, &v) == 0 && *val == 0;
    #define KEY(k) (klen == sizeof(k) - 1 && !strncmp(arg, k, klen))
    if (KEY("accel_fs_g") && scalar && accel_fs_code((unsigned)v) >= 0) next.accel_fs_g = (uint16_t)v;
    else if (KEY("gyro_fs_dps") && scalar && gyro_fs_code((unsigned)v) >= 0) next.gyro_fs_dps = (uint16_t)v;
    else if (KEY("odr_hz") && scalar && odr_code((unsigned)v) >= 0) next.odr_hz = (uint16_t)v;
    else if (KEY("rate_hz") && scalar && v >= 1 && v <= 200) next.rate_hz = (uint16_t)v;
    else if (KEY("mag") && scalar && (v == 0 || v == 1)) next.mag_enabled = (uint8_t)v;
    else if (KEY("mag_hz") && scalar && (v == 10 || v == 20 || v == 50)) next.mag_hz = (uint8_t)v;
    else if (KEY("led") && scalar && v >= 0 && v <= 63) next.led_mask = (uint8_t)v;
    else if (KEY("ma") && scalar && v >= 0 && v < 48) next.mag_axes = (uint8_t)v;
    else if (KEY("can_kbps") && scalar && (v == 125 || v == 250 || v == 500 || v == 1000)) next.can_kbps = (uint16_t)v;
    else if (KEY("can_auto") && scalar && (v == 0 || v == 1)) next.can_auto = (uint8_t)v;
    else if (KEY("can_node") && scalar && v >= 0 && v <= 63) next.can_node = (uint8_t)v;
    else if (KEY("yaw_ms") && scalar && v >= 0 && v <= 255) next.yaw_period_ms = (uint8_t)v;
    else if (KEY("fast_ms") && scalar && v >= 0 && v <= 255) next.fast_period_ms = (uint8_t)v;
    else if (KEY("mag_fusion") && scalar && (v == 0 || v == 1)) next.mag_fusion = (uint8_t)v;
    else if (KEY("gb") && !parse_triple(eq + 1, t)) memcpy(next.gyro_bias_mdps, t, sizeof(t));
    else if (KEY("mo") && !parse_triple(eq + 1, t)) memcpy(next.mag_offset_counts, t, sizeof(t));
    else if (KEY("ms") && !parse_triple(eq + 1, t)) memcpy(next.mag_scale_ppm, t, sizeof(t));
    else { put("ERR bad setting\n"); return; }
    #undef KEY
    if (next.rate_hz > next.odr_hz) { put("ERR rate_hz above odr_hz\n"); return; }
    bool can_changed = next.can_kbps != config.can_kbps || next.can_node != config.can_node;
    config = next; can_node = config.can_node; apply_config(); cfg_line();
    if (can_changed && requested_can) {
        can_node = config.can_node; requested_can_kbps = config.can_kbps;
        if (optional_loads_ready) can_start(requested_can_kbps, requested_can_fd, requested_can_hse);
    }
}


static void can_line(void)
{
    const can_status_t *c = can_status();
    put("CAN"); put(c->on ? " state=on" : " state=off");
    kv("kbps", (int32_t)c->kbps); put(c->hse ? " clock=crystal" : " clock=internal");
    kv("tx", (int32_t)c->tx); kv("rx", (int32_t)c->rx); kv("echoed", (int32_t)c->echoed); kv("bad", (int32_t)c->bad);
    kv("tx_full", (int32_t)c->tx_full); kv("tec", (int32_t)c->tec); kv("rec", (int32_t)c->rec);
    kv("lec", (int32_t)c->lec); kv("bus_off", (int32_t)c->bus_off); kv("passive", (int32_t)c->passive);
    kv("recovery_attempts", (int32_t)c->recovery_attempts); kv("recovery_failed", (int32_t)c->recovery_failed);
    put("\n");
}

/* CAN START <125|250|500|1000> [FD] [INTERNAL] | CAN STOP | CAN STATUS | CAN TEST <n> */
static void can_command(const char *a)
{
    if (!optional_loads_ready && strcmp(a,"STOP") && strcmp(a,"STATUS")) {
        put("ERR USB power budget not granted\n"); return;
    }
    if (!strncmp(a, "START", 5)) {
        const char *p = a + 5; unsigned k = 0;
        while (*p == ' ') ++p;
        while (*p >= '0' && *p <= '9') k = k * 10 + (unsigned)(*p++ - '0');
        bool fd = strstr(p, "FD") != 0, hse = strstr(p, "INTERNAL") == 0;
        const char *pp = strstr(p, "P"); force_presc = 0;
        if (pp && pp[1] >= '1' && pp[1] <= '9') force_presc = (unsigned)(pp[1] - '0');
        if (!k) k = 500;
        can_node = config.can_node;
        if (!can_start(k, fd, hse)) { put("ERR can start (bitrate 125 250 500 1000)\n"); return; }
        requested_can = true; requested_can_kbps = k;
        requested_can_fd = fd; requested_can_hse = hse;
        can_line();
    }
    else if (!strcmp(a, "STOP")) { requested_can = false; can_stop(); can_line(); }
    else if (!strcmp(a, "STATUS")) can_line();
    else if (!strcmp(a, "IDLE")) {
        requested_can = false;
        uint32_t n, lo, ed; can_idle_probe(200, &n, &lo, &ed);
        put("CANIDLE"); kv("samples", (int32_t)n); kv("dominant", (int32_t)lo); kv("edges", (int32_t)ed); put("\n");
    }
    else if (!strncmp(a, "TEST", 4)) {
        const char *p = a + 4; uint32_t n = 0;
        while (*p == ' ') ++p;
        while (*p >= '0' && *p <= '9') n = n * 10 + (uint32_t)(*p++ - '0');
        if (!can_status()->on) { put("ERR can is off: CAN START first\n"); return; }
        can_test(n ? n : 100); put("OK can test running\n");
    }
    else put("ERR use CAN START <kbps> [FD] [INTERNAL] | CAN STOP | CAN STATUS | CAN TEST <n>\n");
}

static int digit(char c)
{
    if (c >= '0' && c <= '9') return c-'0';
    if (c >= 'a' && c <= 'f') return c-'a'+10;
    if (c >= 'A' && c <= 'F') return c-'A'+10;
    return -1;
}

static void command(void)
{
    if (overflow) { put("ERR line too long\n"); return; }
    if (!strcmp(input,"PING")) put("PONG ROTEM\n");
    else if (!strcmp(input,"INFO")) info();
    else if (!strcmp(input,"RAILS")) rails();
    else if (!strncmp(input,"SPIR ",5)) { /* SPIR <hex addr>: read 6 bytes from that register */
        extern int spi_raw(const uint8_t *, uint8_t *, unsigned);
        uint8_t tx[7]={0}, rx[7]={0}; tx[0]=(uint8_t)((digit(input[5])*16+digit(input[6]))|0x80);
        unsigned n = input[7]==' ' ? (unsigned)(input[8]-'0') : 7; if (n < 2 || n > 7) n = 7;
        int e;
        if (input[7]==' ' && input[9]=='i') { e=spi_raw(tx,tx,n); for(unsigned i=0;i<n;++i) rx[i]=tx[i]; } else e=spi_raw(tx,rx,n);
        put("SPIR err="); num(e); put(" n="); num((int32_t)n); put(" rx=");
        for(unsigned i=0;i<n;++i){ hex(rx[i],2); put(" "); } put("\n");
    }
    else if (!strncmp(input,"SPI ",4)) {
        extern int spi_probe(unsigned, unsigned, unsigned);
        unsigned m=(unsigned)(input[4]-'0'), md=(unsigned)(input[6]-'0'), mi=input[7]==' '?(unsigned)(input[8]-'0'):0;
        put("SPI mbr="); num((int32_t)m); put(" mode="); num((int32_t)md); put(" midi="); num((int32_t)mi); put(" whoami="); hex((uint32_t)spi_probe(m,md,mi),2); put("\n");
    }
    else if (!strcmp(input,"DIAG")) {
        extern uint32_t spi_errors, spi_last_sr, clock_source;
        put("DIAG clock="); put(clock_source ? "crystal-160MHz" : "internal-16MHz"); kv("sysclk", (int32_t)SystemCoreClock);
        put(" spi_err="); num((int32_t)spi_errors); put(" spi_sr="); hex(spi_last_sr, 8);
        put(" spi_cfg1="); hex(SPI1->CFG1, 8); put(" spi_cfg2="); hex(SPI1->CFG2, 8); put(" spi_cr1="); hex(SPI1->CR1, 8);
        kv("drdy", (int32_t)imu_drdy_count()); kv("bp", (int32_t)backpressure); kv("ms", (int32_t)tusb_time_millis_api());
        put(" i2c_isr="); hex(I2C1->ISR, 8); put(" ccipr1="); hex(RCC->CCIPR1, 8); put(" ccipr2="); hex(RCC->CCIPR2, 8); put("\n");
    }
    else if (!strcmp(input,"TEST")) { bool s = streaming; streaming = false; selftest(); streaming = s; }
    else if (!strcmp(input,"STREAM ON")) {
        streaming = true; stream_fresh = true; seq = 0; put("OK stream on\n");
    }
    else if (!strcmp(input,"STREAM OFF")) { streaming = false; put("OK stream off\n"); }
    else if (!strcmp(input,"GET")) cfg_line();
    else if (!strncmp(input,"SET ",4)) set_command(input+4);
    else if (!strcmp(input,"SAVE")) {
        int e = config_save();
        if (e) { put("ERR save "); num(e); put("\n"); } else { put("OK saved\n"); cfg_line(); }
    }
    else if (!strcmp(input,"LOAD")) { config_load(); apply_config(); cfg_line(); }
    else if (!strcmp(input,"DEFAULTS")) { config_defaults(); apply_config(); cfg_line(); }
    else if (strlen(input) == 6 && !strncmp(input,"LED ",4) &&
             digit(input[4]) >= 0 && digit(input[5]) >= 0) {
        unsigned mask = (unsigned)(digit(input[4])*16+digit(input[5]));
        if (mask > 63) put("ERR mask 00..3F\n");
        else { set_leds(mask); config.led_mask = (uint8_t)mask; put("OK led "); hex(mask, 2); put("\n"); }
    }
    else if (!strncmp(input,"CAN ",4)) can_command(input+4);
    else if (!strcmp(input,"YAW ZERO")) { set_yaw(0); put("OK yaw 0\n"); }
    else if (!strncmp(input,"YAW SET ",8)) {
        const char *p = input + 8; int32_t v; if (parse_int(&p, &v) || *p) put("ERR YAW SET <degrees>\n");
        else { set_yaw((float)v); put("OK yaw set\n"); }
    }
    else if (!strcmp(input,"FUSION RESET")) { fusion_restart(); put("OK fusion reset\n"); }
    else if (!strcmp(input,"BIAS SAVE")) { /* learned gyro bias into the settings (SAVE to keep it) */
        for (int i = 0; i < 3; ++i) config.gyro_bias_mdps[i] = (int32_t)lrintf(fus.bias[i] * 57295.7795f);
        cfg_line();
    }
    else if (!strcmp(input,"BOOT")) {
        streaming = false; set_leds(0); put("OK rebooting to ROM DFU\n");
        boot_pending = true; boot_at = tusb_time_millis_api()+500;
    }
    else put("ERR commands: PING INFO GET SET k=v SAVE LOAD DEFAULTS RAILS TEST STREAM ON|OFF LED xx BOOT\n");
}

/* ---------- the sensor loop: runs from power-up, with or without a host ----------
 * Every IMU sample (data-ready, at odr_hz) goes through the on-board filter with its time step taken from the
 * crystal (DWT timestamp in the interrupt), so the IMU's own oscillator error does not reach the heading.
 * The magnetometer runs beside it. USB stream lines and CAN frames are produced from the same state. */
static fusion_t fus;
static float yaw_cont, yaw_last_raw, yaw_offset; /* continuous heading for FRC (no wrap at +-180) */
static bool fus_ready, calibrated;
static float still_total;
static uint32_t last_cyc, sample_count;
static imu_sample_t last_s;
static float rate_body[3], accel_g[3];
static uint32_t overruns_total;

/* Magnetometer-to-board axis maps, the same table and order as the studio (src/magaxes.ts). */
static void mag_axis(unsigned idx, const float m[3], float out[3])
{
    static const unsigned char perms[6][3] = { {0,1,2}, {0,2,1}, {1,0,2}, {1,2,0}, {2,0,1}, {2,1,0} };
    unsigned i = idx == 0 ? 4 : idx == 4 ? 0 : idx; /* index 0 is the datasheet default (x, y, -z), built as entry 4 */
    unsigned p = i / 8, sg = i % 8;
    for (int r = 0; r < 3; ++r) out[r] = (sg >> r & 1 ? -1.f : 1.f) * m[perms[p][r]];
}

static void fusion_restart(void)
{
    fusion_init(&fus, &FUSION_DEFAULTS);
    float b[3]; for (int i = 0; i < 3; ++i) b[i] = config.gyro_bias_mdps[i] / 1000.f * 0.01745329252f;
    fusion_set_bias(&fus, b);
    fus_ready = true; calibrated = false; still_total = 0; yaw_cont = 0; yaw_last_raw = 0; yaw_offset = 0;
}

static void mag_task(uint32_t now, float *mag_for_fusion, bool *have_mag)
{
    *have_mag = false;
    if (!config.mag_enabled || (int32_t)(now - next_mag) < 0) return;
    mag_sample_t m = {0};
    int r = mag_poll(&m);
    if (r == 1) {
        if (m.error) { ++mag_errors; mag_last_error = m.error; }
        else {
            last_mag = m; ++mag_seq;
            bool cal = config.mag_scale_ppm[0] || config.mag_scale_ppm[1] || config.mag_scale_ppm[2];
            if (config.mag_fusion && cal) {
                float ms[3];
                for (int i = 0; i < 3; ++i) {
                    float sc = config.mag_scale_ppm[i] ? config.mag_scale_ppm[i] / 1e6f : 1.f;
                    ms[i] = (m.field[i] - config.mag_offset_counts[i]) * sc / 16384.f;
                }
                mag_axis(config.mag_axes, ms, mag_for_fusion); *have_mag = true;
            }
        }
    }
    if (r != 0) {
        { int e = mag_start(); if (e) { ++mag_errors; mag_last_error = 0x100u | (uint32_t)e; } }
        next_mag += 1000u / config.mag_hz;
        if ((int32_t)(now - next_mag) > 0) next_mag = now;
    }
}

static uint8_t flags(void)
{
    extern int usb_present(void);
    return (uint8_t)((fus.still_now ? 1 : 0) | (calibrated ? 2 : 0) | (config.mag_fusion ? 4 : 0) |
                     ((imu_errors || mag_errors) ? 8 : 0) | (usb_present() ? 16 : 0));
}

/* ---------- CAN frames (03_documentation/interfaces.md, "CAN frames") */
static void put16(uint8_t *b, int v) { if (v > 32767) v = 32767; if (v < -32768) v = -32768; b[0] = (uint8_t)v; b[1] = (uint8_t)(v >> 8); }
static void can_frames(uint32_t now)
{
    static uint32_t next_yaw, next_fast, next_status; static uint8_t seq8;
    if (!can_status()->on) return;
    float ypr[3]; fusion_euler(&fus, ypr);
    uint8_t b[8];
    if (config.yaw_period_ms && (int32_t)(now - next_yaw) >= 0) {
        next_yaw = now + config.yaw_period_ms;
        rt_yaw(b, yaw_cont, rate_body[2] * 57.2957795f, flags(), seq8++);
        can_send_frc(RT_YAW, b, 8);
    }
    if (config.fast_period_ms && (int32_t)(now - next_fast) >= 0) {
        next_fast = now + config.fast_period_ms;
        rt_tilt(b, ypr[1], ypr[2], last_s.temp / 128.f + 25, flags(), seq8);
        can_send_frc(RT_TILT, b, 8);
        rt_quat(b, fus.q);
        can_send_frc(RT_QUAT, b, 8);
        rt_vector(b, accel_g, 1000, flags(), seq8);
        can_send_frc(RT_ACCEL, b, 8);
        rt_vector(b, rate_body, 57.2957795f * 8, flags(), seq8);
        can_send_frc(RT_RATES, b, 8);
    }
    if ((int32_t)(now - next_status) >= 0) {
        next_status = now + 1000;
        put16(b, (int)(now / 1000 > 65535 ? 65535 : now / 1000)); b[2] = (uint8_t)(imu_errors > 255 ? 255 : imu_errors);
        b[3] = (uint8_t)(mag_errors > 255 ? 255 : mag_errors); b[4] = flags(); b[5] = 6; b[6] = 0; b[7] = seq8;  /* b5: firmware minor */
        can_send_frc(RT_STATUS, b, 8);
    }
}

/* Commands addressed to this device on CAN: 0x010 set yaw (float32 degrees), 0x011 zero yaw. */
static void set_yaw(float deg) { yaw_offset += deg - yaw_cont; yaw_cont = deg; }
static void on_can_frame(unsigned api, const uint8_t *d, unsigned len)
{
    if (api == RT_SET_YAW) { float v; if (rt_read_yaw(d, len, &v)) set_yaw(v); }
    else if (api == RT_ZERO_YAW) set_yaw(0);
}

static void stream_line(uint32_t now, const imu_sample_t *s, bool use_drdy)
{
    float ypr[3]; fusion_euler(&fus, ypr);
    put("S"); kv("t", (int32_t)now); kv("n", (int32_t)seq++);
    put(" a="); num(s->accel[0]); put(","); num(s->accel[1]); put(","); num(s->accel[2]);
    put(" g="); num(s->gyro[0]); put(","); num(s->gyro[1]); put(","); num(s->gyro[2]);
    put(" m="); num(last_mag.field[0]); put(","); num(last_mag.field[1]); put(","); num(last_mag.field[2]);
    put(" mo="); num(last_mag.offset[0]); put(","); num(last_mag.offset[1]); put(","); num(last_mag.offset[2]);
    kv("mn", (int32_t)mag_seq); kv("temp", s->temp);
    kv("ie", (int32_t)imu_errors); kv("me", (int32_t)mag_errors); kv("mc", (int32_t)mag_last_error);
    kv("ov", (int32_t)overruns_total); put(use_drdy ? " src=drdy" : " src=timer");
    /* on-board fusion: quaternion x10000, yaw/pitch/roll and continuous yaw x100, bias in milli-deg/s, flags */
    put(" q="); for (int i = 0; i < 4; ++i) { num((int32_t)lrintf(fus.q[i] * 10000)); if (i < 3) put(","); }
    put(" ypr="); num((int32_t)lrintf(ypr[0] * 100)); put(","); num((int32_t)lrintf(ypr[1] * 100)); put(","); num((int32_t)lrintf(ypr[2] * 100));
    kv("cy", (int32_t)lrintf(yaw_cont * 100));
    put(" fb="); for (int i = 0; i < 3; ++i) { num((int32_t)lrintf(fus.bias[i] * 57295.7795f)); if (i < 2) put(","); }
    kv("fl", flags());
    put("\n");
}

static void sensor_task(uint32_t now)
{
    float magv[3]; bool have_mag;
    mag_task(now, magv, &have_mag);
    static uint32_t seen, last_drdy_ms; static int32_t acc[7]; static uint32_t accn;
    if (stream_fresh) { stream_fresh = false; accn = 0; memset(acc, 0, sizeof acc); }
    uint32_t c = imu_drdy_count();
    bool drdy = c != seen;
    if (drdy) last_drdy_ms = now;
    bool use_drdy = last_drdy_ms && now - last_drdy_ms < 100;
    imu_sample_t s = {0}; float dt;
    if (drdy) {
        if (c - seen > 1 && seen) overruns_total += c - seen - 1;
        seen = c;
        uint32_t cyc = imu_drdy_cycles();
        dt = last_cyc ? (cyc - last_cyc) / (float)SystemCoreClock : 1.f / config.odr_hz;
        last_cyc = cyc;
        if (sample_count++ % 200 == 0) read_imu(&s); else read_imu_data(&s);
    } else if (!use_drdy && (int32_t)(now - next_sample) >= 0) {
        /* no data-ready (IMU not configured yet, or its interrupt lost): poll, which also configures it */
        next_sample = now + 1000u / config.odr_hz;
        read_imu(&s); dt = 1.f / config.odr_hz; last_cyc = 0;
    } else return;
    if (s.error) { ++imu_errors; return; }
    if (dt > 0.1f) dt = 0.1f;
    last_s = s;
    const float D2R = 0.01745329252f;
    for (int i = 0; i < 3; ++i) {
        accel_g[i] = s.accel[i] * (float)config.accel_fs_g / 32768.f;
        rate_body[i] = s.gyro[i] * (float)config.gyro_fs_dps / 32768.f * D2R;
    }
    if (!fus_ready) fusion_restart();
    fusion_update(&fus, rate_body, accel_g, have_mag ? magv : 0, dt);
    for (int i = 0; i < 3; ++i) rate_body[i] -= fus.bias[i];
    if (fus.still_now) { still_total += dt; if (still_total > 2.f) calibrated = true; }
    float ypr[3]; fusion_euler(&fus, ypr);
    float d = ypr[0] - yaw_last_raw; if (d > 180) d -= 360; if (d < -180) d += 360;
    yaw_last_raw = ypr[0]; yaw_cont += d;
    can_frames(now);
    if (!streaming) return;
    for (int i = 0; i < 3; ++i) { acc[i] += s.accel[i]; acc[3 + i] += s.gyro[i]; }
    acc[6] += s.temp; ++accn;
    uint32_t k = config.odr_hz / config.rate_hz; if (k < 1) k = 1;
    if (accn < k || !room(220)) return;
    for (int i = 0; i < 3; ++i) { s.accel[i] = acc[i] / (int32_t)accn; s.gyro[i] = acc[3 + i] / (int32_t)accn; }
    s.temp = acc[6] / (int32_t)accn;
    memset(acc, 0, sizeof acc); accn = 0;
    stream_line(now, &s, use_drdy);
}

void app_init(void)
{
    RCC->AHB2ENR1 |= RCC_AHB2ENR1_GPIOBEN;
    (void)RCC->AHB2ENR1;
    GPIOB->BSRR = LED_GPIO_MASK;
    GPIOB->OTYPER |= LED_GPIO_MASK;
    for (unsigned i = 0; i < 6; ++i) {
        unsigned shift = pins[i]*2;
        GPIOB->PUPDR &= ~(3u << shift);
        GPIOB->OSPEEDR &= ~(3u << shift);
        GPIOB->MODER = (GPIOB->MODER & ~(3u << shift)) | (1u << shift);
    }
    config_load();
    requested_can = config.can_auto; requested_can_kbps = config.can_kbps;
    requested_can_fd = false; requested_can_hse = true;
    set_leds(config.led_mask);
    CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk; DWT->CYCCNT = 0; DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;
    can_on_frame = on_can_frame; can_node = config.can_node;
    /* Optional loads start in app_task after TinyUSB initialization and budget check. */
}

void app_task(void)
{
    uint32_t now = tusb_time_millis_api();
    extern int usb_present(void);
    bool vbus = usb_present();
    /* Refresh immediately on a VBUS transition: LOW may be USB brownout, not
     * physical disconnection. The periodic check also catches robot rail loss. */
    if (!rail_sampled || vbus != previous_vbus || now - rail_checked_ms >= 100u) {
        extern int read_rails(uint32_t *,uint32_t *,uint32_t *,uint32_t *,uint32_t *);
        uint32_t sense=0, ref=0, cal=0, vdda=0, rail5=0;
        int err = read_rails(&sense,&ref,&cal,&vdda,&rail5);
        rail_ready = rotem_rail_ready(rail_ready, !err, rail5);
        rail_sampled = true; previous_vbus = vbus;
        rail_checked_ms = tusb_time_millis_api();
        now = rail_checked_ms;
    }
    bool allowed = rotem_optional_loads_allowed(rail_ready, vbus, tud_mounted(), tud_suspended());
    if (allowed != optional_loads_ready) {
        optional_loads_ready = allowed;
        set_leds(requested_mask);
        if (!allowed) can_stop();
        else if (requested_can) can_start(requested_can_kbps, requested_can_fd, requested_can_hse);
    }
    if (!tud_cdc_connected()) streaming = false;
    if (out_len) {
        uint32_t n = tud_cdc_write(out, out_len);
        if (n) { memmove(out, out+n, out_len-n); out_len -= n; }
        tud_cdc_write_flush();
    }
    while (tud_cdc_available() && room(512)) {
        char c;
        if (tud_cdc_read(&c,1) != 1) break;
        if (c == '\r') continue;
        if (c == '\n') { input[used] = 0; command(); used = 0; overflow = false; }
        else if (used < sizeof(input)-1) input[used++] = c;
        else overflow = true;
    }
    sensor_task(now);
    can_test_result_t res;
    if (can_task(&res) && room(160)) {
        put("CANTEST"); kv("n", (int32_t)res.n); kv("ok", (int32_t)res.ok); kv("lost", (int32_t)res.lost);
        kv("rtt_min_us", (int32_t)res.rtt_min); kv("rtt_avg_us", (int32_t)res.rtt_avg); kv("rtt_max_us", (int32_t)res.rtt_max);
        put("\n"); can_line();
    }
    if (boot_pending && (int32_t)(now-boot_at) >= 0) {
        boot_request = BOOT_MAGIC;
        __DSB(); NVIC_SystemReset();
    }
}
