#pragma once
#include <stdint.h>
#include <stdbool.h>
/* Three attempts per explicit start. No automatic reset of the budget. */
typedef struct { uint32_t since; unsigned attempts; bool pending; } rotem_recovery_t;
static inline bool rotem_recovery_due(rotem_recovery_t *r, bool bus_off, uint32_t now) {
 if (!bus_off) { r->pending=false; return false; }
 if (r->attempts >= 3) return false;
 if (!r->pending) { r->pending=true; r->since=now; return false; }
 if ((uint32_t)(now-r->since) < (1000u << r->attempts)) return false;
 ++r->attempts; r->pending=false; return true;
}
