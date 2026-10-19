#!/usr/bin/env python3
"""Conservative tracked-file publication gate; inspect findings, never print secret values."""
import pathlib,re,subprocess,sys
root=pathlib.Path(__file__).resolve().parents[1]
paths=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=root).decode().split('\0')
patterns=[rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',rb'gh[pousr]_[A-Za-z0-9]{30,}',rb'AKIA[0-9A-Z]{16}',rb'AIza[0-9A-Za-z_-]{30,}']
bad=[]
for name in set(paths):
 if not name:continue
 p=root/name
 if p.suffix.lower() in {'.kicad_pcb','.kicad_sch','.gbr','.gerber','.step','.stp','.stl'} or p.name in {'units.json','flash-log.csv'} or p.name.startswith('.env'):bad.append(name+': private file type');continue
 if not p.is_file():continue
 b=p.read_bytes()
 if any(re.search(pattern,b) for pattern in patterns):bad.append(name+': credential pattern')
 if re.search(rb'/home/[A-Z][a-z]+/', b):bad.append(name+': private absolute path')
if bad:print('\n'.join(bad));sys.exit(1)
print(f'Publication gate passed: {len(set(paths))-1} files checked; no manufacturing files, private paths or recognized credential patterns.')
