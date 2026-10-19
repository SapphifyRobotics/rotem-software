#pragma once
#include <stdint.h>
#include <stddef.h>

#define CONFIG_VERSION 2u

typedef struct {
    uint32_t magic, version;
    uint16_t accel_fs_g, gyro_fs_dps, odr_hz, rate_hz;
    uint8_t mag_enabled, mag_hz, led_mask, mag_axes; /* mag_axes: host's axis-map index, 0 = datasheet default */
    int32_t gyro_bias_mdps[3];   /* host calibration, applied by the host */
    int32_t mag_offset_counts[3];
    int32_t mag_scale_ppm[3];    /* 1000000 = 1.0; 0 means unset */
    /* version 2: the board works alone on a robot */
    uint16_t can_kbps;           /* 125, 250, 500, 1000 */
    uint8_t can_auto;            /* start CAN at power-up */
    uint8_t can_node;            /* FRC device number 0..63 */
    uint8_t yaw_period_ms;       /* CAN yaw frame period, 0 = off */
    uint8_t fast_period_ms;      /* pitch/roll, quaternion, accel, rates frames, 0 = off */
    uint8_t mag_fusion;          /* use the calibrated magnetometer for heading */
    uint8_t reserved2;
    uint32_t crc;                /* over everything before it */
} config_t;

extern config_t config;
void config_defaults(void);
int config_load(void);         /* 0 loaded, -1 defaults used */
int config_save(void);         /* 0 ok */
int config_saved_matches(void);
int accel_fs_code(unsigned g);
int gyro_fs_code(unsigned dps);
int odr_code(unsigned hz);
