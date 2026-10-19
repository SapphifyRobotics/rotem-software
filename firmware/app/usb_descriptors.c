#include <string.h>
#include "stm32u5xx.h"
#include "tusb.h"

/* TinyUSB example identity for LOCAL PROTOTYPE TESTING ONLY. Not an assigned
 * SAPPHIFY production VID/PID. CDC driver binding requires no custom driver. */
static const tusb_desc_device_t device = {
    .bLength = sizeof(tusb_desc_device_t), .bDescriptorType = TUSB_DESC_DEVICE,
    .bcdUSB = 0x0200, .bDeviceClass = TUSB_CLASS_MISC,
    .bDeviceSubClass = MISC_SUBCLASS_COMMON, .bDeviceProtocol = MISC_PROTOCOL_IAD,
    .bMaxPacketSize0 = 64, .idVendor = 0xcafe, .idProduct = 0x4010,
    .bcdDevice = 0x0001, .iManufacturer = 1, .iProduct = 2,
    .iSerialNumber = 3, .bNumConfigurations = 1,
};
const uint8_t *tud_descriptor_device_cb(void) { return (const uint8_t *)&device; }
static const uint8_t config[] = {
    TUD_CONFIG_DESCRIPTOR(1, 2, 0, TUD_CONFIG_DESC_LEN + TUD_CDC_DESC_LEN, 0, 200),
    TUD_CDC_DESCRIPTOR(0, 4, 0x81, 8, 0x02, 0x82, 64),
};
const uint8_t *tud_descriptor_configuration_cb(uint8_t index)
{ (void)index; return config; }

const uint16_t *tud_descriptor_string_cb(uint8_t index, uint16_t langid)
{
    (void)langid;
    static uint16_t result[40];
    static const char *const strings[] = {
        "", "SAPPHIFY prototype", "ROTEM", "", "ROTEM link"
    };
    unsigned length;
    if (index == 0) { result[1] = 0x0409; length = 1; }
    else if (index == 3) {
        const volatile uint8_t *uid = (const volatile uint8_t *)UID_BASE;
        static const char hex[] = "0123456789ABCDEF";
        length = 24;
        for (unsigned i = 0; i < 12; ++i) {
            result[1+2*i] = hex[uid[i] >> 4];
            result[2+2*i] = hex[uid[i] & 15];
        }
    } else {
        if (index >= sizeof(strings)/sizeof(strings[0])) return NULL;
        length = strlen(strings[index]);
        for (unsigned i = 0; i < length; ++i) result[i+1] = strings[index][i];
    }
    result[0] = (uint16_t)((TUSB_DESC_STRING << 8) | (2*length + 2));
    return result;
}
