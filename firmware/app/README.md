# ROTEM firmware

Experimental STM32U575 firmware; version and toolchain in `../firmware.json`. Implemented interface: `../../protocol/wire-0.6.md`.

Build from a committed tree with `ARM_GCC_BIN=/path/to/bin bash build.sh`. Output contains a binary, ELF, checksum and commit/dirty metadata. CAN recovery uses at most three delayed attempts per explicit start; physical qualification is pending.

The private registered-unit flashing tool and unit records are deliberately excluded. Public `tools/firmware_preflight.py` validates an explicit release manifest and hardware revision without opening or flashing a device. Use the documented STM32 ROM DFU recovery procedure with a verified binary; never infer compatibility from a filename.
