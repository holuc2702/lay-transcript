"""Đóng gói sidecar Python thành binary độc lập bằng PyInstaller.

Sinh ra: resources/sidecar/sidecar          (macOS / Linux)
         resources/sidecar/sidecar.exe      (Windows)

Chạy:  bash scripts/build-sidecar.sh

VÌ SAO PHẢI ĐÓNG GÓI:
  Người dùng không được phải cài Python. PyInstaller gom cả CPython runtime
  và toàn bộ thư viện C vào một thư mục, chạy được mà không cần gì thêm ngoài hệ
  điều hành.
"""

import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SIDECAR = ROOT / "sidecar"
OUT = ROOT / "resources" / "sidecar"
DIST = ROOT / ".sidecar-build"

HERE = Path(__file__).resolve().parent


def run(*args, **kw):
    print("+", " ".join(str(a) for a in args), flush=True)
    return subprocess.run([str(a) for a in args], check=True, **kw)


def venv_dir() -> Path:
    return DIST / "venv"


def venv_python() -> Path:
    if platform.system() == "Windows":
        return DIST / "venv" / "Scripts" / "python.exe"
    return DIST / "venv" / "bin" / "python"


# Python dung de build. CPython 3.12 chon vi co su phu nho cua wheel rong nhat
# cho toan bo chuoi phu thuoc nay (ctranslate2, onnxruntime, av, numpy, tokenizers)
# tren ca ba nen tang. Dung 3.13/3.14 se tiep can vao vung co the thieu wheel,
# dac biet khi build ban Windows tren may macOS/Linux.
BUILD_PYTHON = "3.12"


def find_build_python() -> str:
    """Uu tien Python 3.12.

    Neu chinh interpreter dang chay da la 3.12 thi dung luon — day la truong
    hop pho bien nhat va tranh viec tao venv bang mot ban Python khac.
    """
    if sys.version_info[:2] == (3, 12):
        return sys.executable
    for cand in (f"python{BUILD_PYTHON}", f"python{BUILD_PYTHON}.12", "py"):
        if shutil.which(cand):
            return shutil.which(cand)
    warn(f"Khong tim thay Python {BUILD_PYTHON}; dung {sys.version.split()[0]} thay the.")
    warn("Neu build that bai, hay cai Python 3.12 roi chay lai.")
    return sys.executable


def _is_macho(path: Path) -> bool:
    try:
        with open(path, "rb") as fh:
            magic = fh.read(4)
    except OSError:
        return False
    # Mach-O 64/32-bit (le, be) và "fat" universal
    return magic in (
        b"\xcf\xfa\xed\xfe",
        b"\xfe\xed\xfa\xcf",
        b"\xce\xfa\xed\xfe",
        b"\xfe\xed\xfa\xce",
        b"\xca\xfe\xba\xbe",
        b"\xbe\xba\xfe\xca",
    )


def codesign_sidecar(sidecar_dir: Path, entitlements: Path) -> None:
    """
    Ký ad-hoc MỌI file Mach-O trong sidecar (nhúng sâu nhất trước).

    VÌ SAO BẮT BUỘC:
    Ứng dụng Electron ký "sealed resources" cho toàn bộ .app. PyInstaller nhét
    vào hàng trăm file nhị phân (CTranslate2, onnxruntime, .dylib...) mà không
    ký. Khi cái seal của app không khớp với nội dung thật, dyld giết app ngay
    khi khởi động — crash report ghi "bug_type 309" và báo
    "Lấy Transcript quit unexpectedly", không có lỗi nào trong log.

    Cách sửa: ký trước toàn bộ cây thư mục sidecar, rồi electron-builder mới
    ký vỏ ngoài app. Ký từ trong ra ngoài (sâu trước) vì điều đó bắt buộc với
    framework/bundle.
    """
    if platform.system() != "Darwin":
        return
    if not entitlements.exists():
        warn(f"Khong tim thay {entitlements} — bo qua ky sidecar (app se bi tu choi)")
        return

    targets: list[Path] = []
    for path in sorted(sidecar_dir.rglob("*")):
        if path.is_file() and _is_macho(path):
            targets.append(path)

    say(f"Ky ad-hoc {len(targets)} file Mach-O trong sidecar")

    def depth(p: Path) -> int:
        return len(p.parts)

    signed = 0
    failed = []
    for path in sorted(targets, key=depth, reverse=True):
        cmd = [
            "codesign",
            "--sign",
            "-",
            "--force",
            "--timestamp=none",
            "--options",
            "runtime",
            "--entitlements",
            str(entitlements),
            str(path),
        ]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode == 0:
            signed += 1
        else:
            failed.append((path, r.stderr.strip().splitlines()[-1] if r.stderr.strip() else "?"))

    # Ký từ trong ra ngoài: các bundle (framework, .app, .dylib) sau cùng.
    bundles = [
        p
        for p in sorted(sidecar_dir.rglob("*"))
        if p.is_dir() and p.suffix in (".framework", ".app", ".bundle", ".dylib", ".so")
    ]
    for path in sorted(bundles, key=depth, reverse=True):
        r = subprocess.run(
            [
                "codesign",
                "--sign",
                "-",
                "--force",
                "--timestamp=none",
                "--options",
                "runtime",
                "--entitlements",
                str(entitlements),
                str(path),
            ],
            capture_output=True,
            text=True,
        )
        if r.returncode == 0:
            signed += 1
        else:
            failed.append((path, r.stderr.strip().splitlines()[-1] if r.stderr.strip() else "?"))

    say(f"Da ky {signed} muc")
    if failed:
        warn(f"{len(failed)} muc ky that bai:")
        for p, err in failed[:10]:
            warn(f"  {p.name}: {err}")


def copy_msvc_runtime(venv_dir: Path, sidecar_dir: Path) -> None:
    """
    Chep DLL Visual C++ runtime nganh canh file sidecar.exe.

    Windows chi tim DLL trong thu muc CUA FILE EXE (va cac thu muc da dang ky
    theo). PyInstaller dat mo thu muc `_internal`, nen DLL nam o do se khong duoc
    dung. Chep nganh canh `sidecar.exe` moi la cach dung.

    Thieu cac DLL nay, ctranslate2.dll (viet bang MSVC) khong load duoc va app
    chet ngay khi bat dau ghi am.
    """
    wanted = ("msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll", "concrt140.dll")
    roots = [venv_dir, venv_dir / "Scripts", venv_dir / "Lib" / "site-packages"]
    copied = []
    for root in roots:
        if not root.exists():
            continue
        for name in wanted:
            hits = list(root.rglob(name))
            for src in hits:
                dst = sidecar_dir / name
                if dst.exists():
                    break
                shutil.copy2(src, dst)
                copied.append(name)
                break
    if copied:
        say(f"Chep DLL Visual C++ runtime canh sidecar.exe: {', '.join(sorted(set(copied)))}")
    else:
        warn("KHONG tim thay DLL Visual C++ runtime - ctranslate2 se khong chay duoc tren may nay")


def fix_framework_layout(sidecar_dir: Path) -> None:
    """
    Sửa bố cục Python.framework cho đúng chuẩn macOS.

    PyInstaller copy framework thành thư mục/thư việc THẬT thay vì symlink.
    `codesign` gặp bố cục đó sẽ không xác định được đây là bundle loại gì và báo
    "bundle format is ambiguous (could be app or framework)", khiến bước ký ứng
    dụng thất bại — và bản app sau đó chết ngay khi mở (SIGTRAP).

    Chuẩn framework của macOS dùng symlink:
        Python            -> Versions/Current/Python
        Resources         -> Versions/Current/Resources
        Versions/Current  -> 3.12
    Sửa lại đúng như vậy thì codesign nhận ra ngay.
    """
    framework = sidecar_dir / "_internal" / "Python.framework"
    if not framework.is_dir():
        return

    versions = framework / "Versions"
    candidates = [d for d in versions.iterdir() if d.is_dir() and d.name != "Current"]
    if not candidates:
        return
    # Chọn bản cao nhất theo "V.M.mm"
    def verkey(p: Path):
        parts = p.name.replace("-", ".").split(".")
        return tuple(int(x) for x in parts if x.isdigit())
    target = max(candidates, key=verkey)
    say(f" Sua bo cuc Python.framework -> {target.name}")

    for link, dest in (
        ("Python", f"Versions/Current/{'Python'}"),
        ("Resources", "Versions/Current/Resources"),
    ):
        lp = framework / link
        if lp.is_symlink():
            continue
        if lp.exists() or lp.is_symlink():
            shutil.rmtree(lp) if lp.is_dir() else lp.unlink()
        lp.symlink_to(dest)

    cur = versions / "Current"
    if not cur.is_symlink():
        if cur.exists():
            shutil.rmtree(cur)
        cur.symlink_to(target.name)


def main() -> None:
    DIST.mkdir(exist_ok=True)
    py = venv_python()
    base = find_build_python()

    if not py.exists():
        say(f"Tao moi truong ao ao (venv) bang Python {base}")
        run(base, "-m", "venv", str(DIST / "venv"))

    say("Cai dat phu thuoc (co ghim phien ban)")
    run(py, "-m", "pip", "install", "--quiet", "--upgrade", "pip")
    run(py, "-m", "pip", "install", "--quiet", "-r", SIDECAR / "requirements.txt")

    spec = HERE / "sidecar.spec"
    say("Dong goi bang PyInstaller")
    run(py, "-m", "pip", "install", "--quiet", "pyinstaller==6.22.3")
    # Chi dinh ro distpath/workpath: mac dinh cua PyInstaller la duong dan tuong doi
    # so voi thu muc chay lenh, nen ket qua se vo lung lung.
    run(
        py,
        "-m", "PyInstaller",
        "--noconfirm",
        "--clean",
        "--distpath", str(DIST / "dist"),
        "--workpath", str(DIST / "work"),
        str(spec),
    )

    built = DIST / "dist" / "sidecar"
    if not built.exists():
        raise SystemExit(f"Khong tim thay ket qua PyInstaller: {built}")

    if OUT.exists():
        shutil.rmtree(OUT)
    shutil.copytree(built, OUT)

    if platform.system() == "Darwin":
        fix_framework_layout(OUT)
        codesign_sidecar(OUT, ROOT / "build" / "entitlements.mac.plist")
    if platform.system() == "Windows":
        copy_msvc_runtime(venv_dir(), OUT)

    exe = OUT / ("sidecar.exe" if platform.system() == "Windows" else "sidecar")
    if platform.system() != "Windows":
        exe.chmod(0o755)

    size_mb = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file()) / 1048576
    say(f"Xong: {OUT}  ({size_mb:.0f} MB)")


def say(msg: str) -> None:
    print(f"\033[1;34m==>\033[0m {msg}", flush=True)


def warn(msg: str) -> None:
    print(f"\033[1;33m!!\033[0m  {msg}", flush=True)


if __name__ == "__main__":
    main()
