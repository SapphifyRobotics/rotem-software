/* Device settings, kept in the last 8 KiB flash page. One record, CRC-checked;
 * an erased or corrupt page means defaults. */
#include <string.h>
#include "stm32u5xx.h"
#include "config.h"

#define PAGE_SIZE 8192u
#define CONFIG_MAGIC 0x524F4346u /* "ROCF" */

config_t config;
static const config_t defaults = {
    .magic = CONFIG_MAGIC, .version = CONFIG_VERSION,
    .accel_fs_g = 4, .gyro_fs_dps = 500, .odr_hz = 100, .rate_hz = 100,
    .mag_enabled = 1, .mag_hz = 20,
    .can_kbps = 1000, .can_auto = 1, .can_node = 0, .yaw_period_ms = 10, .fast_period_ms = 20, .mag_fusion = 0,
};

/* Version 1 layout (firmware 0.2.0 - 0.5.0): same fields up to mag_scale_ppm, then crc. */
typedef struct {
    uint32_t magic, version;
    uint16_t accel_fs_g, gyro_fs_dps, odr_hz, rate_hz;
    uint8_t mag_enabled, mag_hz, led_mask, mag_axes;
    int32_t gyro_bias_mdps[3], mag_offset_counts[3], mag_scale_ppm[3];
    uint32_t crc;
} config_v1_t;

static uint32_t crc32(const void *data, unsigned len)
{
    const uint8_t *p = data; uint32_t c = 0xffffffffu;
    while (len--) { c ^= *p++; for (int k = 0; k < 8; ++k) c = (c >> 1) ^ (0xedb88320u & -(c & 1u)); }
    return ~c;
}

static uint32_t page_address(void) { return FLASH_BASE + FLASH_SIZE - PAGE_SIZE; }

void config_defaults(void) { config = defaults; }

int config_load(void)
{
    const config_t *stored = (const config_t *)page_address();
    const config_v1_t *v1 = (const config_v1_t *)page_address();
    if (v1->magic == 0x524F4346u && v1->version == 1u && v1->crc == crc32(v1, offsetof(config_v1_t, crc))) {
        /* Keep the calibration and settings saved by older firmware; new fields take their defaults. */
        config_defaults();
        memcpy(&config.accel_fs_g, &v1->accel_fs_g, offsetof(config_v1_t, crc) - offsetof(config_v1_t, accel_fs_g));
        return 1;
    }
    if (stored->magic != CONFIG_MAGIC || stored->version != CONFIG_VERSION ||
        stored->crc != crc32(stored, offsetof(config_t, crc))) { config_defaults(); return -1; }
    config = *stored;
    return 0;
}

static int flash_wait(void)
{
    while (FLASH->NSSR & FLASH_NSSR_BSY) { }
    uint32_t err = FLASH->NSSR & 0x20fau; /* OPERR PROGERR WRPERR PGAERR SIZERR PGSERR OPTWERR */
    FLASH->NSSR = err | FLASH_NSSR_EOP;
    return err ? -1 : 0;
}

int config_save(void)
{
    config.magic = CONFIG_MAGIC; config.version = CONFIG_VERSION;
    config.crc = crc32(&config, offsetof(config_t, crc));
    if (config_saved_matches()) return 0; /* Avoid erasing unchanged settings. */
    /* Quad-word programming: whole record padded to 16-byte units. */
    static uint32_t words[(sizeof(config_t) + 15) / 16 * 4];
    memset(words, 0xff, sizeof(words)); memcpy(words, &config, sizeof(config_t));

    uint32_t addr = page_address();
    uint32_t bank_size = FLASH_SIZE / 2;
    uint32_t offset = addr - FLASH_BASE;
    int upper = offset >= bank_size;
    int swapped = (FLASH->OPTR & FLASH_OPTR_SWAP_BANK) != 0;
    uint32_t page = (offset % bank_size) / PAGE_SIZE;

    __disable_irq();
    if (FLASH->NSCR & FLASH_NSCR_LOCK) { FLASH->NSKEYR = 0x45670123u; FLASH->NSKEYR = 0xCDEF89ABu; }
    int err = flash_wait();
    if (!err) {
        FLASH->NSCR = FLASH_NSCR_PER | (page << FLASH_NSCR_PNB_Pos) | ((upper ^ swapped) ? FLASH_NSCR_BKER : 0);
        FLASH->NSCR |= FLASH_NSCR_STRT;
        err = flash_wait();
        FLASH->NSCR = 0;
    }
    for (unsigned q = 0; !err && q < sizeof(words) / 16; ++q) {
        FLASH->NSCR = FLASH_NSCR_PG;
        volatile uint32_t *dst = (volatile uint32_t *)(addr + 16 * q);
        for (int k = 0; k < 4; ++k) dst[k] = words[4 * q + k];
        err = flash_wait();
        FLASH->NSCR = 0;
    }
    FLASH->NSCR = FLASH_NSCR_LOCK;
    __enable_irq();
    if (err) return -1;
    return memcmp((const void *)addr, &config, sizeof(config_t)) ? -2 : 0;
}

int config_saved_matches(void)
{
    const config_t *stored = (const config_t *)page_address();
    return stored->magic == CONFIG_MAGIC && !memcmp(stored, &config, offsetof(config_t, crc));
}

/* ICM-45686 field codes (DS-000489 ACCEL_CONFIG0 / GYRO_CONFIG0). */
int accel_fs_code(unsigned g)
{ switch (g) { case 2: return 4; case 4: return 3; case 8: return 2; case 16: return 1; case 32: return 0; } return -1; }
int gyro_fs_code(unsigned dps)
{ switch (dps) { case 125: return 5; case 250: return 4; case 500: return 3; case 1000: return 2; case 2000: return 1; case 4000: return 0; } return -1; }
int odr_code(unsigned hz)
{ switch (hz) { case 25: return 11; case 50: return 10; case 100: return 9; case 200: return 8; case 400: return 7; case 800: return 6; } return -1; }
