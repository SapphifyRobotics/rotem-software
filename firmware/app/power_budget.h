#ifndef ROTEM_POWER_BUDGET_H
#define ROTEM_POWER_BUDGET_H
#include <stdbool.h>
#include <stdint.h>
/* C1 has no readable MUX_ST. With VBUS present, conservatively treat the board
 * as bus-powered even if the robot input is also present. A configured USB
 * host grants the 200 mA descriptor budget. This does not prove suspend current. */
/* Measured-rail brownout guard, not a guarantee of CAN VCC or USB current.
 * Fail closed on ADC errors; hysteresis avoids toggling around one threshold. */
static inline bool rotem_rail_ready(bool was_ready, bool valid, uint32_t rail_mv)
{
    return valid && rail_mv >= (was_ready ? 4500u : 4700u);
}
static inline bool rotem_optional_loads_allowed(bool rail_ready, bool vbus, bool configured, bool suspended)
{
    return rail_ready && (!vbus || (configured && !suspended));
}
#endif
