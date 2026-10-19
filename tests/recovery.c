#include <assert.h>
#include <stdio.h>
#include "recovery.h"
int main(void){rotem_recovery_t r={0};
 assert(!rotem_recovery_due(&r,false,0));assert(!rotem_recovery_due(&r,true,10));assert(!rotem_recovery_due(&r,true,1009));assert(rotem_recovery_due(&r,true,1010));
 assert(!rotem_recovery_due(&r,true,1020));assert(!rotem_recovery_due(&r,true,3019));assert(rotem_recovery_due(&r,true,3020));
 assert(!rotem_recovery_due(&r,true,3030));assert(rotem_recovery_due(&r,true,7030));assert(!rotem_recovery_due(&r,true,99000));assert(r.attempts==3);
 r=(rotem_recovery_t){0};assert(!rotem_recovery_due(&r,true,UINT32_MAX-100));assert(rotem_recovery_due(&r,true,899));
 r=(rotem_recovery_t){0};assert(!rotem_recovery_due(&r,true,1));assert(!rotem_recovery_due(&r,false,500));assert(!rotem_recovery_due(&r,true,900));assert(!rotem_recovery_due(&r,true,1500));
 puts("Recovery policy: delays, exhaustion, clearing and tick rollover passed");}
