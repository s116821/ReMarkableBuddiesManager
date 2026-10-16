"""Stage only trusted CI ZIPs for existing integration checks; never build."""
import os
from pathlib import Path
import shutil
import stat
import sys
import zipfile

def extract(source, destination):
    destination.mkdir(parents=True, exist_ok=False)
    with zipfile.ZipFile(source) as archive:
        for item in archive.infolist():
            relative = Path(item.filename)
            if relative.is_absolute() or ".." in relative.parts or "\\" in item.filename:
                raise ValueError("Unsafe CI package member")
            target = destination / relative
            if item.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            mode = item.external_attr >> 16
            if stat.S_IFMT(mode) not in (0, stat.S_IFREG):
                raise ValueError("Expected regular CI ZIP member")
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(item) as stream, target.open("xb") as output:
                shutil.copyfileobj(stream, output)
            if os.name != "nt":
                target.chmod(mode & 0o777)
    print(f"Staged retained artifact {source.name}")

if __name__ == "__main__":
    directory = Path(sys.argv[1])
    extract(directory / "manager-browser.zip", Path("dist/manager/browser"))
    platform = "win32" if os.name == "nt" else "linux"
    extract(directory / f"manager-{platform}-x64.zip",
            Path(f"out/packages/ReMarkableBuddiesManager-{platform}-x64"))
    shutil.copyfile("dist/manager/browser/build-info.json", "electron/build-info.json")
