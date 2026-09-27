# PyInstaller spec cho sidecar "Lấy Transcript".
#
# Vì sao ONEDIR chứ không phải ONEFILE:
#   Onefile giải nén ra %TEMP% mỗi lần khởi động (chậm ~2-5s) và phụ thuộc
#   %TEMP% còn ghi được. Onedir chỉ giải nén một lần, khởi động tức thì,
#   nên phù hợp hơn cho app cần phản hồi nhanh.
#
# Vì sao loại `pyarrow`:
#   faster-whisper -> huggingface_hub -> fsspec -> pyarrow. Nhưng faster-whisper
#   chỉ dùng hub để TẢI model, không đọc parquet. pyarrow nặng ~120MB và vô
#   dụng ở đây. Đã test: loại bỏ vẫn tải và ghi âm bình thường.
#
# Vì sao phải `collect_data_files("faster_whisper")`:
#   Silero VAD được nạp theo ĐƯỜNG DẪN TỆP
#   (faster_whisper/assets/silero_vad_v6.onnx), không phải bằng import.
#   Nếu faster_whisper nằm trong PYZ, file .onnx đó sẽ không tồn tại và VAD
#   chết lúc chạy (lỗi "silero_vad.onnx failed. File doesn't exist").

import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, copy_metadata

datas = []
# bat buoc: chua silero_vad_v6.onnx + __init__.py cua faster_whisper
datas += collect_data_files("faster_whisper", include_py_files=True)

# Khong co hook PyInstaller cho cac goi nay, phai lay metadata thu cong.
for pkg in ("huggingface-hub", "tokenizers", "tqdm", "numpy"):
    datas += copy_metadata(pkg)

# ---------------------------------------------------------------------------
# DLL Windows phải nằm ở THƯ MỤC GỐC mới được Windows tự tìm thấy.
#
# PyInstaller giữ nguyên cách đặt của package, nên ctranslate2.dll nằm ở
# _internal\ctranslate2\ctranslate2.dll. Windows KHÔNG dò các thư mục con khi nạp
# DLL -> sidecar.exe chạy được nhưng `import ctranslate2` chết ngay:
#
#   Failed to load dynlib/dll '...\_internal\ctranslate2\ctranslate2.dll'.
#   Most likely this dynlib/dll was not found when the application was frozen.
#
# macOS khong dinh loi nay vi dylib duoc tro bang @loader_path nên đặt ở đâu cũng
# chạy — và chép thêm chỉ làm bản macOS phình thêm ~30MB vô ích. Vì vậy chỉ gom
# DLL khi build trên Windows.
# ---------------------------------------------------------------------------
binaries = []
if sys.platform == "win32":
    _seen = set()
    for pkg in ("ctranslate2", "onnxruntime", "av", "tokenizers", "numpy", "huggingface_hub"):
        try:
            found = collect_dynamic_libs(pkg)
        except Exception:  # gói không tồn tại trên nền tảng này -> bỏ qua
            found = []
        for src, _dest in found:
            if src in _seen:
                continue
            _seen.add(src)
            binaries.append((src, "."))

block_cipher = None

# SPECPATH la thu muc chua file .spec (scripts/), nen duong dan tuong doi
# phai noi tu ROOT de tim thay sidecar/worker.py.
ROOT = Path(SPECPATH).resolve().parent

a = Analysis(
    [str(ROOT / "sidecar" / "worker.py")],
    pathex=[str(ROOT)],
    binaries=binaries,
    # BẮT BUỘC phải có. Silero VAD được nạp theo ĐƯỜNG DẪN TỆP
    # (faster_whisper/assets/silero_vad_v6.onnx), không phải bằng import. Nếu
    # faster_whisper nằm trong PYZ thì file .onnx sẽ không tồn tại và VAD chết
    # lúc chạy: "Load model from .../silero_vad_v6.onnx failed".
    # Đã mắc lỗi này một lần: sửa spec làm rơi mất dòng `datas=datas`.
    datas=datas,
    # onnxruntime PHẢI khai báo tay. faster-whisper import nó BÊN TRONG hàm
    # (vad.py -> SileroVADModel.__init__), nên trình dò mã tĩnh của PyInstaller
    # không thấy và bỏ sót -> app chạy được rồi mới chết lúc bật VAD:
    #     "Applying the VAD filter requires the onnxruntime package"
    hiddenimports=["onnxruntime", "onnxruntime.capi._pybind_state"],
    hookspath=[],
    runtime_hooks=[],
    # pyarrow: khong dung, loai de giam 120MB
    excludes=["pyarrow", "pandas", "matplotlib", "IPython", "notebook"],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,          # UPX hay lam hong cac .dylib cua CTranslate2
    console=True,       # phai co stdout/stdio de giao thuc JSON-lines hoat dong
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="sidecar",
)
