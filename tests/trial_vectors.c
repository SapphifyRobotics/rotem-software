#include <stdio.h>
#include <assert.h>
#include "trial_protocol.h"
static void out(unsigned api,uint8_t*b){printf("%03x ",api);for(int i=0;i<8;i++)printf("%02x",b[i]);puts("");}
int main(void){uint8_t b[8];float q[]={1,0,0,0},v[]={1,-2,0.5f},got;
rt_yaw(b,123.5f,-12.25f,3,255);out(RT_YAW,b);
rt_tilt(b,-12.5f,25,30,3,255);out(RT_TILT,b);
rt_quat(b,q);out(RT_QUAT,b);rt_vector(b,v,1000,3,255);out(RT_ACCEL,b);
rt_vector(b,v,8,3,255);out(RT_RATES,b);
rt_yaw(b,INFINITY,0,0,0);assert(!rt_read_yaw(b,4,&got));
rt_yaw(b,NAN,0,0,0);assert(!rt_read_yaw(b,4,&got));
rt_yaw(b,-90,0,0,0);assert(rt_read_yaw(b,4,&got)&&got==-90);assert(!rt_read_yaw(b,3,&got));
return 0;}
