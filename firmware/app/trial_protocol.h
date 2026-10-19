/* ROTEM prototype wire contract 0.6: shared by firmware and host conformance tests. */
#ifndef ROTEM_TRIAL_PROTOCOL_H
#define ROTEM_TRIAL_PROTOCOL_H
#include <stdint.h>
#include <string.h>
#include <math.h>
enum { RT_YAW=0x000, RT_TILT=0x001, RT_QUAT=0x002, RT_ACCEL=0x003,
       RT_RATES=0x004, RT_STATUS=0x005, RT_SET_YAW=0x010, RT_ZERO_YAW=0x011 };
static inline void rt_i16(uint8_t *b, float v) {
    int16_t n=(int16_t)(v>32767 ? 32767 : v < -32768 ? -32768 : v);
    b[0]=(uint8_t)n; b[1]=(uint8_t)((uint16_t)n >> 8);
}
static inline void rt_yaw(uint8_t *b,float yaw,float rate,uint8_t flags,uint8_t seq) {
    uint32_t bits; memcpy(&bits,&yaw,4);
    for (unsigned i=0;i<4;i++) b[i]=(uint8_t)(bits>>(8*i));
    rt_i16(b+4,rate*100); b[6]=flags; b[7]=seq;
}
static inline void rt_tilt(uint8_t *b,float pitch,float roll,float temp,uint8_t flags,uint8_t seq) {
    rt_i16(b,pitch*100);rt_i16(b+2,roll*100);rt_i16(b+4,temp*100);b[6]=flags;b[7]=seq;
}
static inline void rt_quat(uint8_t *b,const float *q) {for(unsigned i=0;i<4;i++)rt_i16(b+2*i,q[i]*32767);}
static inline void rt_vector(uint8_t *b,const float *v,float scale,uint8_t flags,uint8_t seq) {
    for(unsigned i=0;i<3;i++){rt_i16(b+2*i,v[i]*scale);}b[6]=flags;b[7]=seq;
}
static inline int rt_read_yaw(const uint8_t *b,unsigned len,float *value) {
    if(len<4)return 0;
    uint32_t bits=(uint32_t)b[0]|((uint32_t)b[1]<<8)|((uint32_t)b[2]<<16)|((uint32_t)b[3]<<24);
    memcpy(value,&bits,4);return isfinite(*value);
}
#endif
