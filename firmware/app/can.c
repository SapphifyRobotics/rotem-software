/* CAN on FDCAN1, PB8 RX/PB9 TX AF9. PA3 high inhibits transmission:
 * C1 TJA1051T/3 uses silent; D0 TJA1462 uses standby (receiver off).
 * Active operation and the raw idle probe hold PA3 LOW on both variants. Protocol and commands:
 * 03_documentation/interfaces.md, "CAN".
 *
 * Kernel clock: PLL1Q = 16 MHz, from the 16 MHz crystal Y1 (HSE) by default, or from HSI16 for
 * comparison. Every board answers PING frames with an ECHO of the same payload, so any board can
 * test the bus against any other with CAN TEST. */
#include <string.h>
#include "stm32u5xx_hal.h"
#include "tusb.h"
#include "can.h"
#include "recovery.h"
static rotem_recovery_t recovery;

#define PING_ID 0x321u
#define ECHO_ID 0x322u

static FDCAN_HandleTypeDef can;
/* FRC CAN identifier: device type 4 (gyro sensor), manufacturer 8 ("team use", provisional until ROTEM has a
   FIRST vendor ID), 10-bit API, 6-bit device number. */
uint8_t can_node;
uint32_t frc_id(unsigned api) { return (4u << 24) | (8u << 16) | ((api & 0x3FFu) << 6) | (can_node & 0x3Fu); }
void (*can_on_frame)(unsigned api, const uint8_t *data, unsigned len);
static can_status_t st;
static bool fd_mode;
/* CAN TEST state */
static uint32_t test_total, test_sent, test_ok, test_lost, rtt_min, rtt_max, rtt_sum;
static bool waiting; static uint32_t wait_seq, sent_cycles, sent_ms;

static void transceiver_inactive(bool on) { GPIOA->BSRR = on ? (1u << 3) : (1u << (3 + 16)); }
static uint32_t cycles(void) { return DWT->CYCCNT; }

static void pins(void)
{
    RCC->AHB2ENR1 |= RCC_AHB2ENR1_GPIOAEN | RCC_AHB2ENR1_GPIOBEN; (void)RCC->AHB2ENR1;
    transceiver_inactive(true);
    GPIOA->OTYPER &= ~(1u << 3); GPIOA->PUPDR &= ~(3u << 6);
    GPIOA->MODER = (GPIOA->MODER & ~(3u << 6)) | (1u << 6);
    for (unsigned pin = 8; pin <= 9; ++pin) {
        GPIOB->AFR[1] = (GPIOB->AFR[1] & ~(15u << (4 * (pin - 8)))) | (9u << (4 * (pin - 8)));
        GPIOB->OTYPER &= ~(1u << pin); GPIOB->PUPDR &= ~(3u << (2 * pin));
        GPIOB->OSPEEDR |= 3u << (2 * pin);
        GPIOB->MODER = (GPIOB->MODER & ~(3u << (2 * pin))) | (2u << (2 * pin));
    }
}

/* Crystal: the 16 MHz HSE feeds FDCAN directly (FDCANSEL = 00), no PLL in the path, so no PLL jitter.
 * Internal (comparison only): PLL1Q = HSI16 / 4 * 64 / 16 = 16 MHz. */
static bool clock(bool want_hse)
{
    bool hse = false;
    if (want_hse) {
        RCC->CR |= RCC_CR_HSEON;
        uint32_t t = HAL_GetTick();
        while (!(RCC->CR & RCC_CR_HSERDY)) if (HAL_GetTick() - t > 50) break;
        hse = (RCC->CR & RCC_CR_HSERDY) != 0;
    }
    st.hse = hse;
    if (hse) { RCC->CCIPR1 &= ~RCC_CCIPR1_FDCANSEL; return true; }
    extern uint32_t clock_source;
    if (clock_source) return false; /* PLL1 drives the core at 160 MHz: no internal-clock comparison */
    RCC->CR &= ~RCC_CR_PLL1ON;
    uint32_t t = HAL_GetTick();
    while (RCC->CR & RCC_CR_PLL1RDY) if (HAL_GetTick() - t > 100) return false;
    RCC->PLL1CFGR = RCC_PLL1CFGR_PLL1SRC_1 | (3u << RCC_PLL1CFGR_PLL1M_Pos) | RCC_PLL1CFGR_PLL1QEN;
    RCC->PLL1DIVR = (63u << RCC_PLL1DIVR_PLL1N_Pos) | (15u << RCC_PLL1DIVR_PLL1Q_Pos);
    RCC->PLL1FRACR = 0;
    RCC->CR |= RCC_CR_PLL1ON; t = HAL_GetTick();
    while (!(RCC->CR & RCC_CR_PLL1RDY)) if (HAL_GetTick() - t > 100) return false;
    RCC->CCIPR1 = (RCC->CCIPR1 & ~RCC_CCIPR1_FDCANSEL) | RCC_CCIPR1_FDCANSEL_0; /* PLL1Q */
    return true;
}

unsigned force_presc;
bool can_start(unsigned kbps, bool fd, bool want_hse)
{
    /* 16 MHz kernel. Nominal: 32 tq (16 at 1 Mbit/s), sample point 87.5 %. Data (FD): 2 Mbit/s, 8 tq, 75 %. */
    unsigned presc, ts1, ts2, sjw;
    switch (kbps) {
    case 1000: presc = 1; ts1 = 13; ts2 = 2; sjw = 2; break;
    case 500: presc = 1; ts1 = 27; ts2 = 4; sjw = 4; break;
    case 250: presc = 2; ts1 = 27; ts2 = 4; sjw = 4; break;
    case 125: presc = 4; ts1 = 27; ts2 = 4; sjw = 4; break;
    default: return false;
    }
    if (force_presc) { /* diagnostic: same bit rate, other prescaler; 87.5 % sample point */
        unsigned tq = 16000u / (kbps * force_presc);
        if (tq < 8 || tq > 385 || tq * kbps * force_presc != 16000u) return false;
        presc = force_presc; ts2 = tq / 8; if (ts2 < 2) ts2 = 2; ts1 = tq - 1 - ts2; sjw = ts2 < 4 ? ts2 : 4;
    }
    can_stop();
    CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk; DWT->CYCCNT = 0; DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;
    pins();
    if (!clock(want_hse)) return false;
    RCC->APB1ENR2 |= RCC_APB1ENR2_FDCAN1EN; (void)RCC->APB1ENR2;
    RCC->APB1RSTR2 |= RCC_APB1RSTR2_FDCAN1RST; RCC->APB1RSTR2 &= ~RCC_APB1RSTR2_FDCAN1RST;
    memset(&can, 0, sizeof can); can.Instance = FDCAN1;
    can.Init.ClockDivider = FDCAN_CLOCK_DIV1;
    can.Init.FrameFormat = fd ? FDCAN_FRAME_FD_BRS : FDCAN_FRAME_CLASSIC;
    can.Init.Mode = FDCAN_MODE_NORMAL;
    can.Init.AutoRetransmission = ENABLE; can.Init.TransmitPause = DISABLE; can.Init.ProtocolException = ENABLE;
    can.Init.NominalPrescaler = presc; can.Init.NominalSyncJumpWidth = sjw;
    can.Init.NominalTimeSeg1 = ts1; can.Init.NominalTimeSeg2 = ts2;
    can.Init.DataPrescaler = 1; can.Init.DataSyncJumpWidth = 2; can.Init.DataTimeSeg1 = 5; can.Init.DataTimeSeg2 = 2;
    can.Init.StdFiltersNbr = 1; can.Init.ExtFiltersNbr = 1;
    can.Init.TxFifoQueueMode = FDCAN_TX_FIFO_OPERATION;
    if (HAL_FDCAN_Init(&can) != HAL_OK) return false;
    if (fd) { /* transmitter delay compensation, needed for a 2 Mbit/s data phase through the transceiver */
        HAL_FDCAN_ConfigTxDelayCompensation(&can, 6, 0);
        HAL_FDCAN_EnableTxDelayCompensation(&can);
    }
    FDCAN_FilterTypeDef f = { .IdType = FDCAN_STANDARD_ID, .FilterIndex = 0, .FilterType = FDCAN_FILTER_DUAL,
                              .FilterConfig = FDCAN_FILTER_TO_RXFIFO0, .FilterID1 = PING_ID, .FilterID2 = ECHO_ID };
    /* FRC frames addressed to this device: device type, manufacturer and device number match, any API. */
    FDCAN_FilterTypeDef fx = { .IdType = FDCAN_EXTENDED_ID, .FilterIndex = 0, .FilterType = FDCAN_FILTER_MASK,
                               .FilterConfig = FDCAN_FILTER_TO_RXFIFO0, .FilterID1 = frc_id(0),
                               .FilterID2 = 0x1FFF003Fu /* type, manufacturer, device number */ };
    if (HAL_FDCAN_ConfigFilter(&can, &fx) != HAL_OK) return false;
    if (HAL_FDCAN_ConfigFilter(&can, &f) != HAL_OK ||
        HAL_FDCAN_ConfigGlobalFilter(&can, FDCAN_REJECT, FDCAN_REJECT, FDCAN_REJECT_REMOTE, FDCAN_REJECT_REMOTE) != HAL_OK ||
        HAL_FDCAN_Start(&can) != HAL_OK) return false;
    memset(&st.tx, 0, sizeof st - offsetof(can_status_t, tx));
    st.on = true; st.kbps = kbps; fd_mode = fd;
    recovery = (rotem_recovery_t){0};
    transceiver_inactive(false);
    return true;
}

void can_stop(void)
{
    transceiver_inactive(true);
    if (st.on) HAL_FDCAN_Stop(&can);
    st.on = false; test_total = 0; waiting = false;
}

static bool send(uint32_t id, const uint8_t *data, unsigned len)
{
    FDCAN_TxHeaderTypeDef h = { .Identifier = id, .IdType = FDCAN_STANDARD_ID, .TxFrameType = FDCAN_DATA_FRAME,
        .DataLength = len == 8 ? FDCAN_DLC_BYTES_8 : FDCAN_DLC_BYTES_64, .ErrorStateIndicator = FDCAN_ESI_ACTIVE,
        .BitRateSwitch = fd_mode ? FDCAN_BRS_ON : FDCAN_BRS_OFF, .FDFormat = fd_mode ? FDCAN_FD_CAN : FDCAN_CLASSIC_CAN,
        .TxEventFifoControl = FDCAN_NO_TX_EVENTS, .MessageMarker = 0 };
    if (!HAL_FDCAN_GetTxFifoFreeLevel(&can)) { ++st.tx_full; return false; }
    if (HAL_FDCAN_AddMessageToTxFifoQ(&can, &h, data) != HAL_OK) { ++st.tx_full; return false; }
    ++st.tx; return true;
}

static void payload(uint8_t *b, unsigned len, uint32_t seq)
{
    b[0] = 'R'; b[1] = 'T'; b[2] = 1;
    for (unsigned i = 0; i < 4; ++i) b[3 + i] = (uint8_t)(seq >> (8 * i));
    for (unsigned i = 7; i < len; ++i) b[i] = (uint8_t)(seq * 7u + i); /* pattern, checked on return */
}

void can_test(uint32_t n)
{
    test_total = n; test_sent = test_ok = test_lost = rtt_sum = rtt_max = 0; rtt_min = 0xffffffffu; waiting = false;
}

const can_status_t *can_status(void)
{
    if (st.on) {
        FDCAN_ProtocolStatusTypeDef ps = { 0 }; FDCAN_ErrorCountersTypeDef ec = { 0 };
        HAL_FDCAN_GetProtocolStatus(&can, &ps); HAL_FDCAN_GetErrorCounters(&can, &ec);
        st.tec = ec.TxErrorCnt; st.rec = ec.RxErrorCnt; st.bus_off = ps.BusOff; st.passive = ps.ErrorPassive;
        if (ps.LastErrorCode && ps.LastErrorCode != 7) st.lec = ps.LastErrorCode;
    }
    return &st;
}

/* Called from the main loop. Returns true when a CAN TEST has just finished (result in can_test_result). */
bool can_task(can_test_result_t *res)
{
    if (!st.on) return false;
    const can_status_t *status = can_status();
    if (rotem_recovery_due(&recovery, status->bus_off != 0, HAL_GetTick())) {
        /* Stop aborts pending transmissions; Start lets the controller perform bus recovery.
         * Limit retries rather than continuously resetting a faulty physical bus. */
        if (waiting) { ++test_lost; waiting = false; }
        if (HAL_FDCAN_Stop(&can) != HAL_OK || HAL_FDCAN_Start(&can) != HAL_OK) ++st.recovery_failed;
        st.recovery_attempts = recovery.attempts;
    }
    unsigned len = fd_mode ? 64 : 8;
    while (HAL_FDCAN_GetRxFifoFillLevel(&can, FDCAN_RX_FIFO0)) {
        FDCAN_RxHeaderTypeDef h; uint8_t b[64];
        if (HAL_FDCAN_GetRxMessage(&can, FDCAN_RX_FIFO0, &h, b) != HAL_OK) break;
        ++st.rx;
        if (h.RxFrameType != FDCAN_DATA_FRAME) { ++st.bad; continue; }
        if (h.IdType == FDCAN_EXTENDED_ID) {
            if (h.DataLength > FDCAN_DLC_BYTES_8) { ++st.bad; continue; }
            unsigned len = h.DataLength;
            if (can_on_frame) can_on_frame((h.Identifier >> 6) & 0x3FFu, b, len);
            continue;
        }
        if (h.DataLength != FDCAN_DLC_BYTES_8 && h.DataLength != FDCAN_DLC_BYTES_64) { ++st.bad; continue; }
        unsigned got = h.DataLength == FDCAN_DLC_BYTES_64 ? 64 : 8;
        if (b[0] != 'R' || b[1] != 'T' || b[2] != 1) { ++st.bad; continue; }
        uint32_t seq = (uint32_t)b[3] | (uint32_t)b[4] << 8 | (uint32_t)b[5] << 16 | (uint32_t)b[6] << 24;
        if (h.Identifier == PING_ID) { if (send(ECHO_ID, b, got)) ++st.echoed; }
        else if (h.Identifier == ECHO_ID && waiting && seq == wait_seq) {
            uint8_t want[64]; payload(want, got, seq);
            if (got != len || memcmp(b, want, got)) { ++st.bad; continue; }
            uint32_t us = (cycles() - sent_cycles) / (SystemCoreClock / 1000000u);
            ++test_ok; rtt_sum += us; if (us < rtt_min) rtt_min = us; if (us > rtt_max) rtt_max = us;
            waiting = false;
        }
    }
    if (!test_total) return false;
    uint32_t now = HAL_GetTick();
    if (waiting && now - sent_ms > 100) { ++test_lost; waiting = false; }
    if (!waiting && test_sent < test_total) {
        uint8_t b[64]; payload(b, len, ++wait_seq);
        if (send(PING_ID, b, len)) { waiting = true; ++test_sent; sent_cycles = cycles(); sent_ms = now; }
    }
    if (!waiting && test_sent >= test_total) {
        res->n = test_total; res->ok = test_ok; res->lost = test_lost;
        res->rtt_min = test_ok ? rtt_min : 0; res->rtt_max = rtt_max; res->rtt_avg = test_ok ? rtt_sum / test_ok : 0;
        test_total = 0;
        return true;
    }
    return false;
}

/* Bus idle probe: FDCAN stopped, transceiver in normal mode (listening), nothing transmitted by this board.
 * Samples RX (PB8) as fast as possible for `ms` and counts dominant samples and edges. A quiet,
 * correctly biased bus reads recessive (1) throughout. */
void can_idle_probe(uint32_t ms, uint32_t *samples, uint32_t *low, uint32_t *edges)
{
    can_stop(); pins();
    GPIOB->MODER &= ~(3u << 16);           /* PB8 input */
    GPIOB->BSRR = 1u << 9; GPIOB->MODER = (GPIOB->MODER & ~(3u << 18)) | (1u << 18); /* PB9 TXD high = recessive */
    transceiver_inactive(false);
    uint32_t t = HAL_GetTick(), n = 0, lo = 0, ed = 0, prev = 1;
    while (HAL_GetTick() - t < ms) {
        uint32_t v = (GPIOB->IDR >> 8) & 1; ++n;
        if (!v) ++lo;
        if (v != prev) { ++ed; prev = v; }
    }
    transceiver_inactive(true);
    pins();
    *samples = n; *low = lo; *edges = ed;
}

/* One extended-ID data frame, classic CAN (FRC devices read these at 1 Mbit/s). Dropped when the TX FIFO is full. */
bool can_send_frc(unsigned api, const uint8_t *data, unsigned len)
{
    if (!st.on) return false;
    static const uint32_t dlc[9] = { FDCAN_DLC_BYTES_0, FDCAN_DLC_BYTES_1, FDCAN_DLC_BYTES_2, FDCAN_DLC_BYTES_3,
        FDCAN_DLC_BYTES_4, FDCAN_DLC_BYTES_5, FDCAN_DLC_BYTES_6, FDCAN_DLC_BYTES_7, FDCAN_DLC_BYTES_8 };
    FDCAN_TxHeaderTypeDef h = { .Identifier = frc_id(api), .IdType = FDCAN_EXTENDED_ID, .TxFrameType = FDCAN_DATA_FRAME,
        .DataLength = dlc[len > 8 ? 8 : len], .ErrorStateIndicator = FDCAN_ESI_ACTIVE, .BitRateSwitch = FDCAN_BRS_OFF,
        .FDFormat = FDCAN_CLASSIC_CAN, .TxEventFifoControl = FDCAN_NO_TX_EVENTS, .MessageMarker = 0 };
    if (!HAL_FDCAN_GetTxFifoFreeLevel(&can)) { ++st.tx_full; return false; }
    if (HAL_FDCAN_AddMessageToTxFifoQ(&can, &h, data) != HAL_OK) { ++st.tx_full; return false; }
    ++st.tx; return true;
}
