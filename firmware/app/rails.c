#include "stm32u5xx_hal.h"
#include "tusb.h"

static ADC_HandleTypeDef adc;
static int initialized;
uint32_t HAL_GetTick(void) { return tusb_time_millis_api(); }
uint32_t HAL_GetREVID(void) { return DBGMCU->IDCODE >> 16; }

static int sample(uint32_t channel, uint32_t *raw)
{
    ADC_ChannelConfTypeDef c = {0};
    c.Channel = channel;
    c.Rank = ADC_REGULAR_RANK_1;
    c.SamplingTime = ADC_SAMPLETIME_814CYCLES;
    c.SingleDiff = ADC_SINGLE_ENDED;
    c.OffsetNumber = ADC_OFFSET_NONE;
    if (HAL_ADC_ConfigChannel(&adc,&c) != HAL_OK) return 3;
    uint32_t started = HAL_GetTick();
    while (HAL_GetTick()-started < 2) { } /* VREFINT settling. */
    uint32_t sum = 0;
    for (unsigned i=0; i<16; ++i) {
        if (HAL_ADC_Start(&adc) != HAL_OK) return 4;
        if (HAL_ADC_PollForConversion(&adc,20) != HAL_OK) {
            HAL_ADC_Stop(&adc); return 5;
        }
        sum += HAL_ADC_GetValue(&adc);
        if (HAL_ADC_Stop(&adc) != HAL_OK) return 6;
    }
    *raw = (sum+8)/16;
    return 0;
}

int read_rails(uint32_t *sense, uint32_t *ref, uint32_t *cal, uint32_t *vdda, uint32_t *rail5)
{
    if (!initialized) {
        RCC->AHB3ENR |= RCC_AHB3ENR_PWREN;
        (void)RCC->AHB3ENR;
        PWR->SVMCR |= PWR_SVMCR_ASV;
        RCC->CCIPR3 = (RCC->CCIPR3 & ~RCC_CCIPR3_ADCDACSEL) | RCC_CCIPR3_ADCDACSEL_0;
        RCC->AHB2ENR1 |= RCC_AHB2ENR1_ADC12EN | RCC_AHB2ENR1_GPIOAEN;
        (void)RCC->AHB2ENR1;
        GPIOA->MODER |= 3u << 2; /* PA1 = 5V_SENSE via R28/R29 (100k each). */
        GPIOA->MODER |= 3u << 0; GPIOA->PUPDR &= ~3u; /* PA0 = VIN_SENSE: R22..R26 5 x 100k over R27 22.1k. */
        GPIOA->PUPDR &= ~(3u << 2);
        adc.Instance = ADC1;
        adc.Init.ClockPrescaler = ADC_CLOCK_ASYNC_DIV4;
        adc.Init.Resolution = ADC_RESOLUTION_14B;
        adc.Init.DataAlign = ADC_DATAALIGN_RIGHT;
        adc.Init.ScanConvMode = ADC_SCAN_DISABLE;
        adc.Init.EOCSelection = ADC_EOC_SINGLE_CONV;
        adc.Init.NbrOfConversion = 1;
        adc.Init.ExternalTrigConv = ADC_SOFTWARE_START;
        adc.Init.ExternalTrigConvEdge = ADC_EXTERNALTRIGCONVEDGE_NONE;
        adc.Init.Overrun = ADC_OVR_DATA_PRESERVED;
        adc.Init.ConversionDataManagement = ADC_CONVERSIONDATA_DR;
        adc.Init.LeftBitShift = ADC_LEFTBITSHIFT_NONE;
        adc.Init.TriggerFrequencyMode = ADC_TRIGGER_FREQ_LOW;
        if (HAL_ADC_Init(&adc) != HAL_OK) return 1;
        if (HAL_ADCEx_Calibration_Start(&adc,ADC_CALIB_OFFSET_LINEARITY,ADC_SINGLE_ENDED) != HAL_OK) return 2;
        initialized = 1;
    }
    int error = sample(ADC_CHANNEL_VREFINT,ref);
    if (error) return error;
    error = sample(ADC_CHANNEL_6,sense);
    if (error) return error;
    /* Factory calibration is 14-bit, at a 3.000 V analog reference. */
    *cal = *VREFINT_CAL_ADDR;
    if (*ref == 0 || *cal == 0 || *cal == 0xffff) return 7;
    *vdda = 3000u * *cal / *ref;
    *rail5 = (2u * *vdda * *sense + 8191u) / 16383u;
    return 0;
}

/* Robot supply after the reverse-polarity FET (VIN_P), through 500 k / 22.1 k: V = sense x 522.1 / 22.1.
 * Call after read_rails() (needs the ADC and vdda). */
int read_vin(uint32_t vdda_mv, uint32_t *vin_mv)
{
    uint32_t raw = 0; int e = sample(ADC_CHANNEL_5, &raw); if (e) return e;
    *vin_mv = (uint32_t)((uint64_t)vdda_mv * raw * 5221u / (16383u * 221u));
    return 0;
}
/* USB VBUS present: PC13 through 100 k / 100 k (2.5 V when plugged). */
int usb_present(void)
{
    RCC->AHB2ENR1 |= RCC_AHB2ENR1_GPIOCEN; (void)RCC->AHB2ENR1;
    GPIOC->MODER &= ~(3u << 26); GPIOC->PUPDR &= ~(3u << 26);
    return (GPIOC->IDR >> 13) & 1u;
}
