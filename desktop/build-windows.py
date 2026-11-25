#!/usr/bin/env python3
"""Assemble a portable Windows app from the pinned, checksum-verified Electron runtime."""
from __future__ import annotations
import argparse
import hashlib
import pathlib
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile

VERSION='45.5.0'
FILENAME=f'electron-v{VERSION}-win32-x64.zip'
BASE=f'https://github.com/electron/electron/releases/download/v{VERSION}'
ROOT=pathlib.Path(__file__).resolve().parent.parent
RUNTIME_EXTENSIONS={'.html','.js','.mjs','.cjs','.css','.json','.png','.jpg','.jpeg','.webp','.gif','.svg','.ico','.woff','.woff2','.ttf','.otf','.wasm'}

def app_files() -> list[tuple[pathlib.Path,str]]:
    """Include the full renderer, while keeping local tests and scratch files out."""
    dist=ROOT/'dist'
    if not (dist/'index.html').is_file():
        raise FileNotFoundError('Missing dist/index.html. Build the renderer before packaging.')
    result=[]
    for source in sorted(dist.rglob('*')):
        relative=source.relative_to(dist)
        if not source.is_file() or source.is_symlink():
            continue
        if any(part.startswith('.') or part in {'node_modules','__pycache__','tests','test','coverage','screenshots'} for part in relative.parts):
            continue
        if source.suffix.lower() not in RUNTIME_EXTENSIONS:
            continue
        if source.name.endswith(('.test.js','.spec.js','.test.cjs','.spec.cjs','.test.mjs','.spec.mjs')):
            continue
        result.append((source,'dist/'+relative.as_posix()))
    return result

def download(url: str, target: pathlib.Path) -> None:
    with urllib.request.urlopen(url,timeout=120) as response,target.open('wb') as out:
        shutil.copyfileobj(response,out,1024**2)

def sha(path: pathlib.Path) -> str:
    with path.open('rb') as f:
        return hashlib.file_digest(f,'sha256').hexdigest()

def build() -> None:
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--cache',type=pathlib.Path,help='Directory containing the official runtime archive and SHASUMS256.txt.')
    ap.add_argument('--zig',type=pathlib.Path,help='Path to the Zig executable. Builds the optional native Windows x64 touchpad module.')
    ap.add_argument('--output',required=True,type=pathlib.Path)
    args=ap.parse_args()
    out=args.output.resolve()
    out.parent.mkdir(parents=True,exist_ok=True)
    renderer_files=app_files()
    with tempfile.TemporaryDirectory(prefix='caogaozhi-') as tmp:
        stage=pathlib.Path(tmp)
        cache=args.cache.resolve() if args.cache else stage
        cache.mkdir(parents=True,exist_ok=True)
        runtime=cache/FILENAME
        listing=cache/'SHASUMS256.txt'
        for p in [listing,runtime]:
            if not p.is_file():
                temp=p.with_suffix(p.suffix+'.partial')
                download(f'{BASE}/{p.name}',temp)
                temp.replace(p)
        expected=next((line.split()[0] for line in listing.read_text().splitlines() if line.split() and line.split()[-1].lstrip('*')==FILENAME),None)
        actual=sha(runtime)
        if expected is None or expected!=actual:
            ap.error('Electron archive checksum mismatch. No app package was written.')
        module=stage/'touchpad-win32-x64.node'
        if args.zig:
            subprocess.run([str(args.zig.resolve()),'cc','-target','x86_64-windows-gnu','-O2','-shared',
                            '-Werror','-Wall',str(ROOT/'desktop/native/touchpad.c'),'-lcomctl32','-luser32',
                            '-o',str(module)],check=True)
        with zipfile.ZipFile(runtime) as rt,zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=3) as result:
            prefix='草稿纸/'
            for info in rt.infolist():
                if info.is_dir():
                    continue
                dst='草稿纸.exe' if info.filename=='electron.exe' else info.filename
                with rt.open(info) as source,result.open(prefix+dst,'w') as target:
                    shutil.copyfileobj(source,target,1024**2)
            app=prefix+'resources/app/'
            for name in ['main.cjs','preload.cjs','package.json','icon.png','windows-touchpad.cjs','touchpad-motion.cjs']:
                result.write(ROOT/'desktop'/name,app+name)
            if module.is_file():
                result.write(module,app+module.name)
            for source,destination in renderer_files:
                result.write(source,app+destination)
            result.writestr(prefix+'使用前先读.txt','草稿纸 Windows x64 预览版\r\n请完整解压，双击“草稿纸.exe”。不要只移动 EXE。\r\n草稿保存到本机。首次运行未签名版本，Windows 可能提示。\r\n'.encode('utf-8-sig'))
        print(f'{sha(out)}  {out}')

if __name__=='__main__':
    build()
