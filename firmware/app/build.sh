#!/usr/bin/env bash
# Builds the ROTEM app firmware. Toolchain and vendor trees as pinned in firmware.json.
set -euo pipefail
cd "$(dirname "$0")"
tool_dir="${ARM_GCC_BIN:-$HOME/.arduino15/packages/arduino/tools/arm-none-eabi-gcc/7-2017q4/bin}"
cmsis=../vendor
tusb=../vendor/tinyusb/src
hal=../vendor/stm32u5-hal
mkdir -p build
# Build identity: the product repository's commit and whether the firmware sources differ from it.
commit=$(git -C ../.. rev-parse --short=7 HEAD 2>/dev/null || echo unknown)
dirty=0; git -C ../.. diff --quiet HEAD -- firmware 2>/dev/null || dirty=1
version=$(sed -n 's/^#define FW_VERSION "\(.*\)"/\1/p' app.c)
"$tool_dir/arm-none-eabi-gcc" -mcpu=cortex-m33 -mthumb -mfloat-abi=hard -mfpu=fpv5-sp-d16 \
  -std=gnu11 -Os -g3 -Wall -Wextra -Werror -DSTM32U575xx -DFW_COMMIT=\"$commit\" -DFW_DIRTY=$dirty \
  -ffunction-sections -fdata-sections -I. -I"$cmsis/stm32u5" \
  -I"$cmsis/cmsis-core" -I"$tusb" -I"$hal/Inc" \
  main.c app.c config.c can.c fusion.c rails.c sensors.c usb_descriptors.c ../vendor/startup_stm32u575xx.s \
  "$hal/Src/stm32u5xx_hal_adc.c" "$hal/Src/stm32u5xx_hal_adc_ex.c" "$hal/Src/stm32u5xx_hal_fdcan.c" \
  "$cmsis/stm32u5/system_stm32u5xx.c" \
  "$tusb/tusb.c" "$tusb/common/tusb_fifo.c" "$tusb/device/usbd.c" \
  "$tusb/class/cdc/cdc_device.c" \
  "$tusb/portable/synopsys/dwc2/dcd_dwc2.c" \
  "$tusb/portable/synopsys/dwc2/dwc2_common.c" \
  -nostdlib -Wl,--gc-sections,-Map=build/rotem-app.map \
  -Tlinker.ld -Wl,--start-group -lc -lm -lgcc -lnosys -Wl,--end-group \
  -o build/rotem-app.elf
"$tool_dir/arm-none-eabi-objcopy" -O binary build/rotem-app.elf build/rotem-app.bin
"$tool_dir/arm-none-eabi-size" build/rotem-app.elf
sha256sum build/rotem-app.bin > build/rotem-app.bin.sha256
printf '{"version": "%s", "commit": "%s", "dirty": %s, "built": "%s", "sha256": "%s"}\n' "$version" "$commit" "$dirty" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(cut -d' ' -f1 build/rotem-app.bin.sha256)" > build/build-info.json
cat build/build-info.json
