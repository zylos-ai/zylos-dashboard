#!/usr/bin/env python3
"""Build experimental helpers on native Linux x86_64 into a NEW directory."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', required=True, help='New isolated output directory; must not exist')
parser.add_argument('--cc', default='cc', help='C compiler executable (no flags)')
args = parser.parse_args()
if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'amd64'):
    parser.error('native Linux x86_64 is required; cross builds are not acceptance evidence')
source_dir = Path(__file__).resolve().parent
root = source_dir.parent.parent
out = Path(args.output).absolute()
out.mkdir(mode=0o700, parents=False, exist_ok=False)
flags = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-D_FILE_OFFSET_BITS=64']
def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()
manifest = {'schema': 1, 'platform': 'linux-x64', 'status': 'experimental-native-validation-required',
            'compiler': subprocess.check_output([args.cc, '--version'], text=True).splitlines()[0],
            'flags': flags, 'binaries': {}, 'buildScriptSha256': sha(Path(__file__).resolve())}
for name in ('linux-guardian', 'marked-exec', 'pty-marked-exec'):
    source = source_dir / (name + '.c')
    command = [args.cc, *flags, str(source), '-o', str(out / name)]
    if name == 'pty-marked-exec':
        command.append('-lutil')
    subprocess.run(command, check=True)
    elf = (out / name).read_bytes()[:20]
    if len(elf) != 20 or elf[:6] != b'\x7fELF\x02\x01' or int.from_bytes(elf[18:20], 'little') != 62:
        raise RuntimeError('compiler output is not a Linux-compatible ELF64 x86_64 executable')
    os.chmod(out / name, 0o700)
    manifest['binaries'][name] = {'sha256': sha(out / name), 'source': str(source.relative_to(root)),
                                  'sourceSha256': sha(source)}
(out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'output': str(out), 'manifestSha256': sha(out / 'manifest.json'),
                  'status': 'built-not-validated'}))
