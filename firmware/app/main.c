#include "stm32u5xx.h"
#include "tusb.h"

static volatile uint32_t milliseconds;
void SysTick_Handler(void) { ++milliseconds; }
uint32_t tusb_time_millis_api(void) { return milliseconds; }
void OTG_FS_IRQHandler(void) { tusb_int_handler(0, true); }
/* Pure C, no C++ constructors or runtime registration. */
void __libc_init_array(void) { }


/* Core at 160 MHz from the 16 MHz crystal Y1: voltage range 1 with the EPOD booster, 4 flash wait
 * states, PLL1 = HSE / 1 * 20 / 2. If the crystal does not start, the core stays on HSI16.
 * USB keeps its own HSI48 + CRS; FDCAN takes HSE directly (can.c). */
uint32_t clock_source; /* 0 = HSI16 16 MHz, 1 = HSE PLL 160 MHz */
static void clock_160(void)
{
    RCC->CR |= RCC_CR_HSEON;
    for (uint32_t i = 0; i < 400000u && !(RCC->CR & RCC_CR_HSERDY); ++i) { }
    if (!(RCC->CR & RCC_CR_HSERDY)) return;
    /* Booster clock = PLL1 source / MBOOST must be 4..16 MHz before BOOSTEN: HSE / 1. */
    RCC->PLL1CFGR = (RCC_PLL1CFGR_PLL1SRC_0 | RCC_PLL1CFGR_PLL1SRC_1) | (0u << RCC_PLL1CFGR_PLL1M_Pos) |
                    (3u << RCC_PLL1CFGR_PLL1RGE_Pos) | (0u << RCC_PLL1CFGR_PLL1MBOOST_Pos) | RCC_PLL1CFGR_PLL1REN;
    RCC->PLL1DIVR = (19u << RCC_PLL1DIVR_PLL1N_Pos) | (1u << RCC_PLL1DIVR_PLL1R_Pos) | (1u << RCC_PLL1DIVR_PLL1P_Pos) | (15u << RCC_PLL1DIVR_PLL1Q_Pos);
    PWR->VOSR = (PWR->VOSR & ~PWR_VOSR_VOS) | PWR_VOSR_VOS_0 | PWR_VOSR_VOS_1 | PWR_VOSR_BOOSTEN;
    for (uint32_t i = 0; i < 400000u && (PWR->VOSR & (PWR_VOSR_VOSRDY | PWR_VOSR_BOOSTRDY)) != (PWR_VOSR_VOSRDY | PWR_VOSR_BOOSTRDY); ++i) { }
    if ((PWR->VOSR & (PWR_VOSR_VOSRDY | PWR_VOSR_BOOSTRDY)) != (PWR_VOSR_VOSRDY | PWR_VOSR_BOOSTRDY)) return;
    FLASH->ACR = (FLASH->ACR & ~FLASH_ACR_LATENCY) | FLASH_ACR_LATENCY_4WS;
    while ((FLASH->ACR & FLASH_ACR_LATENCY) != FLASH_ACR_LATENCY_4WS) { }
    RCC->CR |= RCC_CR_PLL1ON;
    for (uint32_t i = 0; i < 400000u && !(RCC->CR & RCC_CR_PLL1RDY); ++i) { }
    if (!(RCC->CR & RCC_CR_PLL1RDY)) return;
    RCC->CFGR2 = 0; RCC->CFGR3 = 0; /* AHB, APB1, APB2, APB3 undivided: 160 MHz */
    RCC->CFGR1 = (RCC->CFGR1 & ~RCC_CFGR1_SW) | RCC_CFGR1_SW_0 | RCC_CFGR1_SW_1;
    while ((RCC->CFGR1 & RCC_CFGR1_SWS) != (RCC_CFGR1_SWS_0 | RCC_CFGR1_SWS_1)) { }
    SystemCoreClockUpdate();
    clock_source = 1;
}

static void usb_hardware_init(void)
{
    __disable_irq();
    SysTick->CTRL = 0;
    for (unsigned i = 0; i < 16; ++i) {
        NVIC->ICER[i] = 0xffffffffu;
        NVIC->ICPR[i] = 0xffffffffu;
    }
    /* HSI16 for AHB (USB FS requires >=14.2 MHz), independent HSI48 for USB.
     * No dependency on the external crystal, LEDs, IMU or CAN circuitry. */
    FLASH->ACR = (FLASH->ACR & ~FLASH_ACR_LATENCY) | FLASH_ACR_LATENCY_1WS;
    RCC->CR |= RCC_CR_HSION | RCC_CR_HSI48ON;
    while ((RCC->CR & (RCC_CR_HSIRDY | RCC_CR_HSI48RDY)) !=
           (RCC_CR_HSIRDY | RCC_CR_HSI48RDY)) { }
    RCC->CFGR1 = (RCC->CFGR1 & ~RCC_CFGR1_SW) | RCC_CFGR1_SW_0;
    while ((RCC->CFGR1 & RCC_CFGR1_SWS) != RCC_CFGR1_SWS_0) { }
    RCC->CFGR2 = 0;
    RCC->CFGR3 = 0;
    SystemCoreClockUpdate();
    RCC->CCIPR1 &= ~RCC_CCIPR1_ICLKSEL; /* HSI48. */
    RCC->AHB3ENR |= RCC_AHB3ENR_PWREN;
    (void)RCC->AHB3ENR;
    PWR->SVMCR |= PWR_SVMCR_USV;       /* VDDUSB is wired to 3V3D. */
    RCC->AHB2ENR1 |= RCC_AHB2ENR1_GPIOAEN | RCC_AHB2ENR1_OTGEN;
    (void)RCC->AHB2ENR1;
    for (unsigned pin = 11; pin <= 12; ++pin) {
        unsigned shift = 2u * pin;
        GPIOA->PUPDR &= ~(3u << shift);
        GPIOA->OTYPER &= ~(1u << pin);
        GPIOA->OSPEEDR |= 3u << shift;
        GPIOA->AFR[1] = (GPIOA->AFR[1] & ~(15u << (4u * (pin-8u)))) |
                        (10u << (4u * (pin-8u)));
        GPIOA->MODER = (GPIOA->MODER & ~(3u << shift)) | (2u << shift);
    }
    RCC->AHB2RSTR1 |= RCC_AHB2RSTR1_OTGRST;
    RCC->AHB2RSTR1 &= ~RCC_AHB2RSTR1_OTGRST;
    /* CRS tunes HSI48 from the host's 1 kHz USB SOF packets. */
    RCC->APB1ENR1 |= RCC_APB1ENR1_CRSEN;
    (void)RCC->APB1ENR1;
    CRS->CFGR = CRS_CFGR_SYNCSRC_1 | (34u << CRS_CFGR_FELIM_Pos) | 47999u;
    CRS->CR |= CRS_CR_AUTOTRIMEN | CRS_CR_CEN;
    clock_160();
    SysTick_Config(SystemCoreClock / 1000u);
    NVIC_SetPriority(OTG_FS_IRQn, 2);
    __enable_irq();
}

extern void app_init(void);
extern void app_task(void);
extern void boot_recovery_check(void);
int main(void)
{
    boot_recovery_check();
    usb_hardware_init();
    app_init();
    tud_configure_dwc2_t cfg = CFG_TUD_CONFIGURE_DWC2_DEFAULT;
    cfg.vbus_sensing = false;
    tud_configure(0, TUD_CFGID_DWC2, &cfg);
    tusb_rhport_init_t init = { .role = TUSB_ROLE_DEVICE, .speed = TUSB_SPEED_FULL };
    if (!tusb_init(0, &init)) { for (;;) { } }
    for (;;) { tud_task(); app_task(); }
}
