#pragma once
#include <stdint.h>

#define FUSION_WINDOW 50 /* samples in the stillness window (0.5 s at 100 Hz) */

typedef struct {
    int zero_rate, hold_still;
    float gyro_noise, bias_noise, accel_noise, heading_noise; /* rad/s/sqrtHz, rad/s^2/sqrtHz, g, rad */
    float still_gyro_std, still_accel_std, still_max_rate;    /* rad/s, g, rad/s */
} fusion_params_t;

typedef struct {
    float g[FUSION_WINDOW][3], a[FUSION_WINDOW][3];
    float gs[3], gq[3], as[3], aq[3];
    int head, count;
} still_t;

typedef struct {
    fusion_params_t p;
    float q[4], bias[3], P[6][6];
    still_t still;
    int still_now;
    float still_time;   /* seconds the board has been still, continuously */
    uint32_t updates;
} fusion_t;

extern const fusion_params_t FUSION_DEFAULTS;
void fusion_init(fusion_t *f, const fusion_params_t *p);
void fusion_set_bias(fusion_t *f, const float b[3]);
/* gyro rad/s and accel g in the board frame; mag (any unit, board frame) or NULL; dt seconds */
void fusion_update(fusion_t *f, const float gyro[3], const float accel[3], const float *mag, float dt);
void fusion_euler(const fusion_t *f, float ypr_deg[3]); /* yaw, pitch, roll */
void fusion_set_yaw(fusion_t *f, float yaw_deg);
