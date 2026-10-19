#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>

typedef struct {
    bool on, hse;
    unsigned kbps;
    uint32_t tx, rx, echoed, bad, tx_full;   /* counters, reset by can_start */
    uint32_t tec, rec, lec, bus_off, passive, recovery_attempts, recovery_failed;
} can_status_t;

typedef struct { uint32_t n, ok, lost, rtt_min, rtt_avg, rtt_max; } can_test_result_t; /* rtt in us */

bool can_start(unsigned kbps, bool fd, bool want_hse);
void can_stop(void);
void can_test(uint32_t n);
const can_status_t *can_status(void);
bool can_task(can_test_result_t *res);
void can_idle_probe(uint32_t ms, uint32_t *samples, uint32_t *low, uint32_t *edges);
extern unsigned force_presc; /* 0 = table; diagnostic override of the nominal prescaler */
extern uint8_t can_node;                     /* FRC device number, set before can_start */
uint32_t frc_id(unsigned api);
bool can_send_frc(unsigned api, const uint8_t *data, unsigned len);
extern void (*can_on_frame)(unsigned api, const uint8_t *data, unsigned len); /* frames addressed to us */
