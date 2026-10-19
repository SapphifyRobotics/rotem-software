#pragma once
#include <stdint.h>
typedef struct {
    uint32_t id, error, power, accel_config, gyro_config, status;
    int32_t accel[3], gyro[3], temp;
} imu_sample_t;
typedef struct { uint32_t id, error, status; int32_t field[3], offset[3]; } mag_sample_t;
void read_imu(imu_sample_t *sample);
void read_mag(mag_sample_t *sample);
int mag_start(void);
int mag_poll(mag_sample_t *sample); /* 0 busy, 1 done (check error), -1 idle */
int read_imu_data(imu_sample_t *sample); /* data only, fast */
void sensors_reconfigure(void); /* apply config on the next read */
uint32_t imu_drdy_count(void); /* data-ready pulses seen on INT1 */
uint32_t imu_drdy_cycles(void); /* DWT cycle count at the latest data-ready pulse */
