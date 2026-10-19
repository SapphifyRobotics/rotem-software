#pragma once
#define HAL_ADC_MODULE_ENABLED
#define HAL_FDCAN_MODULE_ENABLED
#define USE_HAL_FDCAN_REGISTER_CALLBACKS 0U
#define USE_HAL_ADC_REGISTER_CALLBACKS 0U
#define USE_FULL_ASSERT 0U
#define assert_param(expr) ((void)0U)
#include "stm32u5xx_hal_rcc.h"
#include "stm32u5xx_hal_dma.h"
#include "stm32u5xx_hal_adc.h"
#include "stm32u5xx_hal_fdcan.h"
