"""Regenerates the archive samples the reader tests run against.

Written by tar and by WinRAR themselves: a reader checked only against archives
it could also have written proves nothing about the ones it will meet.

Files are written in binary so the fixtures do not differ between platforms -
Python's text mode turns "\n" into "\r\n" on Windows, which changes every size
the tests assert.

    python scripts/make-archive-fixtures.py
"""

import os
import shutil
import subprocess
import tarfile
import tempfile

OUT = os.path.join("apps", "web", "src", "lib", "__fixtures__")
RAR = r"C:\Program Files\WinRAR\Rar.exe"


def write(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(text.encode("utf-8"))


def build_tree(root: str) -> None:
    write(os.path.join(root, "readme.txt"), "hello from the archive\n")
    write(os.path.join(root, "src", "main.ts"), "export const a = 1;\n")
    write(os.path.join(root, "src", "lib", "util.ts"), "export const b = 2;\n")
    # A name too long for a tar header, which forces the GNU long-name entry.
    deep = os.path.join(root, *(["a-very-long-directory-name-that-goes-on"] * 4), "deep.txt")
    write(deep, "deep\n")


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    work = tempfile.mkdtemp()
    build_tree(work)

    for name, mode in [("sample.tar", "w"), ("sample.tar.gz", "w:gz")]:
        with tarfile.open(os.path.join(OUT, name), mode) as archive:
            archive.add(work, arcname=".")

    target = os.path.abspath(os.path.join(OUT, "sample.rar"))
    if os.path.exists(target):
        os.remove(target)
    if os.path.exists(RAR):
        subprocess.run([RAR, "a", "-r", "-ep1", target, "."], cwd=work, check=True, capture_output=True)
    else:
        print("WinRAR not found; sample.rar left unchanged")

    shutil.rmtree(work, ignore_errors=True)
    for name in ("sample.tar", "sample.tar.gz", "sample.rar"):
        path = os.path.join(OUT, name)
        print(name, os.path.getsize(path) if os.path.exists(path) else "MISSING")
