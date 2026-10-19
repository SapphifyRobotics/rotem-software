#!/usr/bin/env python3
"""Offline verification only: never connects to or flashes a device."""
import argparse,hashlib,json,pathlib,sys
p=argparse.ArgumentParser();p.add_argument('binary',type=pathlib.Path);p.add_argument('manifest',type=pathlib.Path);p.add_argument('--hardware',required=True);a=p.parse_args()
m=json.loads(a.manifest.read_text());digest=hashlib.sha256(a.binary.read_bytes()).hexdigest()
if a.hardware not in m.get('hardware_revisions',[]):sys.exit('STOP: hardware revision is not listed in this manifest')
if digest!=m.get('sha256'):sys.exit('STOP: checksum mismatch')
if m.get('dirty') or not m.get('commit'):sys.exit('STOP: firmware has no clean commit identity')
print('Checksum and declared hardware match. This does not qualify hardware or authorize flashing. Read release limitations and DFU recovery instructions.')
