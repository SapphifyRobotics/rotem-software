#include "stm32u5xx.h"
#include "tusb.h"
#include "sensors.h"
#include "config.h"

/* Sensor buses on the MCU peripherals: SPI1 (PA5 SCK, PA6 MISO, PA7 MOSI, AF5; PA4 = IMU CS by GPIO),
 * mode 0, 10 MHz from the 160 MHz kernel (ICM-45686: up to 24 MHz). I2C1 (PB6 SCL, PB7 SDA, AF4,
 * open drain with the board's R5/R6 pull-ups) at about 390 kHz for the MMC5983MA. Pins as in the
 * frozen Rev C netlist (04_verification/pcb-vs-firmware.md). */
static int buses_ready, imu_ready, mag_ready;
/* ICM-45686 data-ready on IMU_INT1 = PA8, EXTI line 8, rising edge. */
static volatile uint32_t drdy_count;
static volatile uint32_t drdy_cycles; /* DWT cycle count at the latest pulse: sample time from the crystal */
void EXTI8_IRQHandler(void) { if (EXTI->RPR1 & (1u << 8)) { EXTI->RPR1 = 1u << 8; drdy_cycles = DWT->CYCCNT; ++drdy_count; } }
uint32_t imu_drdy_count(void) { return drdy_count; }
uint32_t imu_drdy_cycles(void) { return drdy_cycles; }
static void drdy_init(void)
{
    RCC->AHB2ENR1 |= RCC_AHB2ENR1_GPIOAEN; (void)RCC->AHB2ENR1;
    GPIOA->MODER &= ~(3u << 16); GPIOA->PUPDR = (GPIOA->PUPDR & ~(3u << 16)) | (2u << 16); /* input, pull-down */
    EXTI->EXTICR[2] &= ~0xffu;                     /* line 8 <- port A */
    EXTI->RTSR1 |= 1u << 8; EXTI->FTSR1 &= ~(1u << 8);
    EXTI->RPR1 = 1u << 8; EXTI->IMR1 |= 1u << 8;
    NVIC_SetPriority(EXTI8_IRQn, 3); NVIC_EnableIRQ(EXTI8_IRQn);
}
/* Non-blocking magnetometer cycle for streaming (mag_start/mag_poll). */
static int mag_busy;
static uint32_t mag_started;
static void wait_ms(uint32_t ms)
{ uint32_t start=tusb_time_millis_api(); while(tusb_time_millis_api()-start<ms) { } }
static void af(GPIO_TypeDef *p,unsigned pin,unsigned fn,int open_drain)
{
    unsigned shift=pin*2;
    p->PUPDR&=~(3u<<shift); p->OSPEEDR|=3u<<shift;
    if(open_drain) p->OTYPER|=1u<<pin; else p->OTYPER&=~(1u<<pin);
    p->AFR[pin>>3]=(p->AFR[pin>>3]&~(15u<<(4*(pin&7))))|(fn<<(4*(pin&7)));
    p->MODER=(p->MODER&~(3u<<shift))|(2u<<shift);
}
static void buses_init(void)
{
    if(buses_ready) return;
    RCC->AHB2ENR1|=RCC_AHB2ENR1_GPIOAEN|RCC_AHB2ENR1_GPIOBEN;
    RCC->APB2ENR|=RCC_APB2ENR_SPI1EN; RCC->APB1ENR1|=RCC_APB1ENR1_I2C1EN; (void)RCC->APB1ENR1;
    GPIOA->BSRR=1u<<4; GPIOA->MODER=(GPIOA->MODER&~(3u<<8))|(1u<<8); GPIOA->OTYPER&=~(1u<<4);
    af(GPIOA,5,5,0); af(GPIOA,6,5,0); af(GPIOA,7,5,0);
    SPI1->CR1=0;
    /* SystemCoreClock is 160 MHz (or 16 MHz if the crystal failed): /16 or /2 gives 10 or 8 MHz. */
    uint32_t mbr = SystemCoreClock > 80000000u ? 3u : 0u;
    SPI1->CFG1=(mbr<<SPI_CFG1_MBR_Pos)|(7u<<SPI_CFG1_DSIZE_Pos);
    /* SSI must already be high when MASTER is set with software slave management, or MASTER does not stick. */
    SPI1->CR1=SPI_CR1_SSI;
    SPI1->CFG2=SPI_CFG2_SSM|SPI_CFG2_AFCNTR;
    SPI1->CFG2=SPI_CFG2_MASTER|SPI_CFG2_SSM|SPI_CFG2_AFCNTR;
    af(GPIOB,6,4,1); af(GPIOB,7,4,1);
    I2C1->CR1=0;
    /* PCLK1 160 MHz: PRESC 7 (50 ns), SCLL 29, SCLH 15, SDADEL 2, SCLDEL 4: about 390 kHz.
       At 16 MHz (crystal failed): PRESC 1 (125 ns) gives ~1/10 of the timing values' periods. */
    I2C1->TIMINGR = SystemCoreClock > 80000000u ? 0x70420F1Du : 0x00420F13u;
    I2C1->CR1=I2C_CR1_PE;
    buses_ready=1; wait_ms(2);
}
uint32_t spi_errors, spi_last_sr;
/* One SPI1 transaction of n bytes. Every wait is bounded, so a fault returns an error instead of
 * stopping the main loop (and USB with it). */
static int spi_xfer(const uint8_t *tx, uint8_t *rx, unsigned n)
{
    uint32_t guard;
    #define WAIT(cond) for (guard = 0; !(cond); ) if (++guard > 200000u) { spi_last_sr = SPI1->SR; ++spi_errors; SPI1->CR1 &= ~SPI_CR1_SPE; return -1; }
    SPI1->CR1&=~SPI_CR1_SPE;
    SPI1->IFCR=0xffffffffu;
    SPI1->CR2=n;
    SPI1->CR1|=SPI_CR1_SPE; SPI1->CR1|=SPI_CR1_CSTART;
    for(unsigned i=0;i<n;++i) {
        WAIT(SPI1->SR&SPI_SR_TXP);
        *(volatile uint8_t *)&SPI1->TXDR = tx ? tx[i] : 0;
        WAIT(SPI1->SR&SPI_SR_RXP);
        uint8_t v = *(volatile uint8_t *)&SPI1->RXDR;
        if(rx) rx[i]=v;
    }
    WAIT(SPI1->SR&SPI_SR_EOT);
    #undef WAIT
    SPI1->IFCR=SPI_IFCR_EOTC|SPI_IFCR_TXTFC;
    SPI1->CR1&=~SPI_CR1_SPE;
    return 0;
}
static void imu_read(uint8_t addr,uint8_t *data,unsigned len)
{
    /* One trailing dummy byte: the last byte of an SPI1 transfer reads back corrupted on this setup
       (2-byte WHO_AM_I read returns 0x01, 3 bytes return 0xE9 in place), so it is clocked and discarded. */
    uint8_t buf[26]={0}; buf[0]=addr|0x80; if(len>23) len=23;
    GPIOA->BSRR=1u<<(4+16);
    if(spi_xfer(buf,buf,len+2)) { for(unsigned i=0;i<len;++i) buf[i+1]=0; }
    GPIOA->BSRR=1u<<4;
    for(unsigned i=0;i<len;++i) data[i]=buf[i+1];
}
static uint8_t imu_reg(uint8_t addr) { uint8_t v; imu_read(addr,&v,1); return v; }
static void imu_write(uint8_t addr,uint8_t v)
{
    uint8_t buf[2]={addr,v};
    GPIOA->BSRR=1u<<(4+16); spi_xfer(buf,0,2); GPIOA->BSRR=1u<<4;
}
void read_imu(imu_sample_t *s)
{
    *s=(imu_sample_t){0}; buses_init(); s->id=imu_reg(0x72);
    if(s->id!=0xe9) { s->error=1; return; }
    uint8_t acfg=(uint8_t)((accel_fs_code(config.accel_fs_g)<<4)|odr_code(config.odr_hz));
    uint8_t gcfg=(uint8_t)((gyro_fs_code(config.gyro_fs_dps)<<4)|odr_code(config.odr_hz));
    if(!imu_ready) {
        imu_write(0x1b,acfg); /* ACCEL_CONFIG0: UI full scale, ODR (config.h). */
        imu_write(0x1c,gcfg); /* GYRO_CONFIG0. */
        imu_write(0x10,0x0f); /* Accel + gyro low-noise modes, internal clock. */
        /* INT1 (PA8): data ready, push-pull, pulse, active high. Polarity/mode first, while interrupts are off. */
        imu_write(0x16,0x00); imu_write(0x18,0x01); imu_write(0x16,0x04);
        drdy_init();
        wait_ms(100); imu_ready=1;
    }
    s->power=imu_reg(0x10); s->accel_config=imu_reg(0x1b); s->gyro_config=imu_reg(0x1c);
    if(s->power!=0x0f || s->accel_config!=acfg || s->gyro_config!=gcfg) {
        s->error=2; imu_ready=0; return;
    }
    s->status=imu_reg(0x19);
    uint8_t raw[14]; imu_read(0,raw,sizeof(raw));
    /* DS-000489 section 14: reset default is LITTLE endian, despite the
     * register names in section 16 depicting the big-endian interpretation. */
    for(unsigned i=0;i<3;++i) {
        s->accel[i]=(int16_t)((unsigned)raw[2*i]|((unsigned)raw[2*i+1]<<8));
        s->gyro[i]=(int16_t)((unsigned)raw[6+2*i]|((unsigned)raw[7+2*i]<<8));
    }
    s->temp=(int16_t)((unsigned)raw[12]|((unsigned)raw[13]<<8));
}

/* I2C1 transactions to the MMC5983MA (7-bit address 0x30). Error codes kept from the software version:
 * 1 bus busy, 2 address NACK, 3 register NACK, 4 restart/read address, 5 read timeout, 6 data NACK, 9 stop. */
static int i2c_wait(uint32_t flag)
{
    uint32_t t=tusb_time_millis_api();
    while(!(I2C1->ISR&flag)) {
        if(I2C1->ISR&I2C_ISR_NACKF) { I2C1->ICR=I2C_ICR_NACKCF|I2C_ICR_STOPCF; return -2; }
        if(tusb_time_millis_api()-t>3) return -1;
    }
    return 0;
}
static int mag_read(uint8_t addr,uint8_t *out,unsigned count)
{
    if(I2C1->ISR&I2C_ISR_BUSY) { I2C1->CR1=0; I2C1->CR1=I2C_CR1_PE; if(I2C1->ISR&I2C_ISR_BUSY) return 1; }
    I2C1->CR2=(0x30u<<1)|(1u<<I2C_CR2_NBYTES_Pos)|I2C_CR2_START;
    if(i2c_wait(I2C_ISR_TXIS)) return 2;
    I2C1->TXDR=addr;
    if(i2c_wait(I2C_ISR_TC)) return 3;
    I2C1->CR2=(0x30u<<1)|I2C_CR2_RD_WRN|(count<<I2C_CR2_NBYTES_Pos)|I2C_CR2_AUTOEND|I2C_CR2_START;
    for(unsigned i=0;i<count;++i) { if(i2c_wait(I2C_ISR_RXNE)) return i ? 5 : 4; out[i]=(uint8_t)I2C1->RXDR; }
    if(i2c_wait(I2C_ISR_STOPF)) return 9;
    I2C1->ICR=I2C_ICR_STOPCF; return 0;
}
static int mag_write(uint8_t addr,uint8_t value)
{
    if(I2C1->ISR&I2C_ISR_BUSY) { I2C1->CR1=0; I2C1->CR1=I2C_CR1_PE; if(I2C1->ISR&I2C_ISR_BUSY) return 1; }
    I2C1->CR2=(0x30u<<1)|(2u<<I2C_CR2_NBYTES_Pos)|I2C_CR2_AUTOEND|I2C_CR2_START;
    if(i2c_wait(I2C_ISR_TXIS)) return 2;
    I2C1->TXDR=addr;
    if(i2c_wait(I2C_ISR_TXIS)) return 3;
    I2C1->TXDR=value;
    if(i2c_wait(I2C_ISR_STOPF)) return 6;
    I2C1->ICR=I2C_ICR_STOPCF; return 0;
}

/* MMC5983MA datasheet, "SET and RESET": a measurement after SET reads +H + offset, after RESET
 * -H + offset. Half their difference is the field with the bridge offset (and its temperature
 * drift) removed; half their sum is that offset. Every reported field is such a pair. */
static void unpack(const uint8_t raw[7], int32_t out[3])
{
    for(unsigned i=0;i<3;++i)
        out[i]=(int32_t)(((uint32_t)raw[2*i]<<10)|((uint32_t)raw[2*i+1]<<2)|((raw[6]>>(6-2*i))&3))-131072;
}
static int mag_init(void)
{
    uint8_t id=0; int e=mag_read(0x2f,&id,1); if(e) return e;
    if(id!=0x30) return 7;
    e=mag_write(0x0a,0); if(e) return e;  /* CTRL1: all axes, 100 Hz bandwidth, 8 ms conversion. */
    e=mag_write(0x0b,0); if(e) return e;  /* CTRL2: no continuous mode, no periodic set. */
    mag_ready=1; return 0;
}
/* One cycle: pulse (SET 0x08 or RESET 0x10), start a measurement (TM_M), wait, read. */
static int mag_measure_blocking(uint8_t pulse, int32_t out[3])
{
    int e=mag_write(0x09,pulse); if(e) return e;
    wait_ms(1);
    e=mag_write(0x09,0x01); if(e) return e;
    uint32_t start=tusb_time_millis_api(); uint8_t status=0;
    do {
        e=mag_read(0x08,&status,1); if(e) return e;
        if(tusb_time_millis_api()-start>50) return 8;
    } while(!(status&1));
    uint8_t raw[7]; e=mag_read(0,raw,7); if(e) return e;
    unpack(raw,out); return 0;
}
static void combine(const int32_t set[3], const int32_t reset[3], mag_sample_t *s)
{
    for(unsigned i=0;i<3;++i) { s->field[i]=(set[i]-reset[i])/2; s->offset[i]=(set[i]+reset[i])/2; }
}

void read_mag(mag_sample_t *s)
{
    /* A blocking read takes over the bus and ends any streaming cycle. */
    *s=(mag_sample_t){0}; buses_init(); mag_busy=0;
    uint8_t id=0; s->error=(uint32_t)mag_read(0x2f,&id,1); s->id=id;
    if(s->error) return;
    if(!mag_ready && (s->error=(uint32_t)mag_init())) return;
    int32_t a[3], b[3];
    if((s->error=(uint32_t)mag_measure_blocking(0x08,a))) return;
    if((s->error=(uint32_t)mag_measure_blocking(0x10,b))) return;
    s->status=1; combine(a,b,s);
}

/* Streaming: the same SET/RESET pair as a state machine, polled from the main loop. */
static int32_t pair_set[3];
static int mag_phase; /* 1: SET measurement running, 2: RESET measurement running */
static int start_phase(uint8_t pulse)
{
    int e=mag_write(0x09,pulse); if(e) return e;
    for(volatile unsigned i=0;i<SystemCoreClock/100000u;++i) __NOP(); /* pulse is 500 ns; ~10+ us margin */
    e=mag_write(0x09,0x01); if(e) return e;
    mag_started=tusb_time_millis_api(); return 0;
}
int mag_start(void)
{
    buses_init();
    if(!mag_ready) { int e=mag_init(); if(e) return e; }
    int e=start_phase(0x08); if(e) return e;
    mag_busy=1; mag_phase=1; return 0;
}
int mag_poll(mag_sample_t *s)
{
    if(!mag_busy) return -1;
    uint8_t status=0; int e=mag_read(0x08,&status,1);
    if(!e && !(status&1)) {
        if(tusb_time_millis_api()-mag_started>50) { mag_busy=0; s->error=8; return 1; }
        return 0;
    }
    if(e) { mag_busy=0; s->error=(uint32_t)e; return 1; }
    uint8_t raw[7]; e=mag_read(0,raw,7);
    if(e) { mag_busy=0; s->error=(uint32_t)e; return 1; }
    if(mag_phase==1) {
        unpack(raw,pair_set);
        e=start_phase(0x10);
        if(e) { mag_busy=0; s->error=(uint32_t)e; return 1; }
        mag_phase=2; return 0;
    }
    int32_t reset[3]; unpack(raw,reset);
    mag_busy=0; s->error=0; s->id=0x30; s->status=status; combine(pair_set,reset,s);
    return 1;
}
/* Streaming read: data registers only, after read_imu() has configured the IMU. */
int read_imu_data(imu_sample_t *s)
{
    if(!imu_ready) { read_imu(s); return (int)s->error; }
    uint8_t raw[14]; imu_read(0,raw,sizeof(raw));
    for(unsigned i=0;i<3;++i) {
        s->accel[i]=(int16_t)((unsigned)raw[2*i]|((unsigned)raw[2*i+1]<<8));
        s->gyro[i]=(int16_t)((unsigned)raw[6+2*i]|((unsigned)raw[7+2*i]<<8));
    }
    s->temp=(int16_t)((unsigned)raw[12]|((unsigned)raw[13]<<8));
    s->error=0; return 0;
}

void sensors_reconfigure(void) { imu_ready=0; }

/* Diagnostic: reconfigure SPI1 (baud divider code 0..7 = /2../256, mode 0..3, MISO sample delay) and read WHO_AM_I. */
int spi_probe(unsigned mbr, unsigned mode, unsigned midi)
{
    buses_init();
    SPI1->CR1=SPI_CR1_SSI;
    SPI1->CFG1=(mbr<<SPI_CFG1_MBR_Pos)|(7u<<SPI_CFG1_DSIZE_Pos);
    SPI1->CFG2=SPI_CFG2_SSM|SPI_CFG2_AFCNTR|((mode&2)?SPI_CFG2_CPOL:0)|((mode&1)?SPI_CFG2_CPHA:0);
    SPI1->CFG2|=SPI_CFG2_MASTER|(midi<<SPI_CFG2_MIDI_Pos);
    imu_ready=0;
    return imu_reg(0x72);
}

/* Diagnostic: raw SPI transaction, CS low, sends tx[0..n-1], returns what came back. */
int spi_raw(const uint8_t *tx, uint8_t *rx, unsigned n)
{
    buses_init();
    GPIOA->BSRR=1u<<(4+16); int e=spi_xfer(tx,rx,n); GPIOA->BSRR=1u<<4; return e;
}
