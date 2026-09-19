#!/usr/bin/env python3
"""Build Observer helpers for the native supported host into a new directory."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, help='New output directory; must not exist')
    parser.add_argument('--cc', default='cc', help='C compiler executable (no flags)')
    args = parser.parse_args()
    machine = platform.machine().lower()
    arch = {'x86_64': 'x64', 'amd64': 'x64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(machine)
    system = platform.system()
    host = {'Darwin': 'darwin', 'Linux': 'linux'}.get(system)
    target = f'{host}-{arch}'
    if target not in ('darwin-arm64', 'linux-x64', 'linux-arm64'):
        parser.error('supported native hosts: macOS arm64, Linux x64 and Linux arm64')
    source_dir = Path(__file__).resolve().parent
    root = source_dir.parents[2]
    out = Path(args.output).absolute()
    out.mkdir(mode=0o700, parents=False, exist_ok=False)
    flags = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-D_FILE_OFFSET_BITS=64']
    manifest = {
        'schema': 1, 'platform': target, 'buildMachine': machine,
        'status': 'experimental-native-validation-required',
        'compiler': subprocess.check_output([args.cc, '--version'], text=True).splitlines()[0],
        'flags': flags, 'binaries': {}, 'buildScriptSha256': sha(Path(__file__).resolve()),
    }
    sources = [(host + '-guardian', 'guardian'), ('marked-exec', 'marked-exec'),
               ('pty-marked-exec', 'pty-marked-exec')]
    for name, source_name in sources:
        source = source_dir / (source_name + '.c')
        command = [args.cc, *flags, str(source), '-o', str(out / name)]
        if name == 'pty-marked-exec' and host == 'linux':
            command.append('-lutil')
        subprocess.run(command, check=True)
        header = (out / name).read_bytes()[:20]
        if host == 'linux':
            expected_machine = 62 if arch == 'x64' else 183
            valid = (len(header) == 20 and header[:6] == b'\x7fELF\x02\x01'
                     and int.from_bytes(header[18:20], 'little') == expected_machine)
        else:
            valid = (len(header) == 20 and header[:4] == b'\xcf\xfa\xed\xfe'
                     and int.from_bytes(header[4:8], 'little') == 0x0100000c)
        if not valid:
            raise RuntimeError(f'compiler output does not match native target {target}: {name}')
        os.chmod(out / name, 0o700)
        manifest['binaries'][name] = {
            'sha256': sha(out / name), 'source': str(source.relative_to(root)),
            'sourceSha256': sha(source), 'command': command,
        }
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'output': str(out), 'manifestSha256': sha(out / 'manifest.json'),
                      'status': 'built-not-validated'}))


if __name__ == '__main__':
    main()
