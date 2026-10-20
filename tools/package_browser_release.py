#!/usr/bin/env python3
"""Mirror a reviewed GitHub release into Studio; never build or flash firmware.

Usage: python3 tools/package_browser_release.py v0.6.4-bench.1
Requires gh authenticated for public release downloads. Only this repository is used.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('tag')
args = parser.parse_args()
if not re.fullmatch(r'v[\w.-]+', args.tag):
    raise SystemExit('Invalid release tag')
repository = 'SapphifyRobotics/rotem-software'
metadata = json.loads(subprocess.check_output(['gh', 'release', 'view', args.tag, '--repo', repository, '--json', 'isDraft,isPrerelease']))
if metadata['isDraft']:
    raise SystemExit('Cannot distribute a draft')
with tempfile.TemporaryDirectory() as temp:
    subprocess.run(['gh', 'release', 'download', args.tag, '--repo', repository, '-p', 'release-manifest.json', '-p', 'rotem-app.bin', '-D', temp], check=True)
    manifest = json.loads((Path(temp) / 'release-manifest.json').read_text())
    binary = (Path(temp) / 'rotem-app.bin').read_bytes()
digest = hashlib.sha256(binary).hexdigest()
if digest != manifest.get('sha256') or manifest.get('dirty') != 0:
    raise SystemExit('Checksum or clean-build identity check failed')
if not re.fullmatch(r'[a-f0-9]{7,40}', manifest.get('commit', '')):
    raise SystemExit('Missing commit identity')
if manifest.get('hardware_revisions') != ['C1'] or not 8 <= len(binary) <= 1040384:
    raise SystemExit('Unsupported hardware or image length')
sp, pc = struct.unpack_from('<II', binary)
if sp != 0x20030000 or not pc & 1 or not 0x08000000 <= pc < 0x08000000 + len(binary):
    raise SystemExit('Invalid application vectors')
channel = 'experimental' if metadata['isPrerelease'] else 'stable'
if manifest.get('channel') != channel:
    raise SystemExit('Channel mismatch')
if channel == 'stable' and manifest.get('hardware_qualified') is not True:
    raise SystemExit('Stable release requires recorded hardware qualification')
entry = {key: manifest[key] for key in ('version', 'commit', 'sha256', 'dirty', 'hardware_revisions', 'physical_tests')}
entry.update(tag=args.tag, channel=channel, bytes=len(binary), image=f'/firmware/{digest}.bin')
dest = Path(__file__).resolve().parents[1] / 'studio/public/firmware'
dest.mkdir(parents=True, exist_ok=True)
catalog = dest / 'catalog.json'
entries = json.loads(catalog.read_text()) if catalog.exists() else []
entries = [entry] + [r for r in entries if r['tag'] != args.tag]
(dest / f'{digest}.bin').write_bytes(binary)
catalog.write_text(json.dumps(entries, indent=2) + '\n')
print(f'Packaged {args.tag}: {len(binary)} bytes, SHA-256 {digest}')
