"""
Sidecar Python cho "Lấy Transcript".

Chạy như một tiến trình con, giao tiếp với Electron qua stdio.
Mỗi dòng JSON trên stdin là MỘT lệnh; mỗi dòng JSON trên stdout là MỘT
phản hồi hoặc sự kiện. Không dùng stdout cho việc khác (không print).

Vì sao tách Python ra tiến trình riêng thay vì nhúng?
  - PyInstaller đóng gói sẵn, khỏi phải lo cài Python cho người dùng.
  - Sập bên trong (hết RAM khi nạp model) không làm mất dữ liệu đã tải.
  - Có thể huỷ giữa chừng dễ dàng.
"""

import json
import os
import sys
import threading
import time
import traceback

# Trên Windows, stdout của tiến trình đóng gói mặc định là cp1252, KHÔNG phải
# UTF-8. Khi đó mỗi dòng JSON chứa tiếng Trung / tiếng Việt đều làm
#     UnicodeEncodeError: 'charmap' codec can't encode character ...
# và tiến trình chết ngay — nghĩa là chỉ cần ghi âm tiếng Trung là app hỏng.
# Phải ép UTF-8 ngay từ đầu, trước mọi thứ khác.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001  # stream đã bị thay thế / không hỗ trợ
        pass

# stdout phải sạch tuyệt đối: nếu thư viện nào đó in ra stdout, giao thức sẽ hỏng.
_OUT = sys.stdout
sys.stdout = sys.stderr  # mọi print/stdout của thư viện đổi sang stderr


def emit(obj):
    """Gửi một đối tượng JSON ra stdout, kèm xuống dòng."""
    line = json.dumps(obj, ensure_ascii=False)
    try:
        _OUT.write(line + "\n")
    except UnicodeEncodeError:
        # Lưới an toàn cuối: nếu vì lý do gì không viết được UTF-8, dùng dạng
        # escape ASCII. JSON vẫn hợp lệ và Electron vẫn giải mã được — thà mất
        # một chút tốc độ còn hơn làm sập tiến trình.
        _OUT.write(json.dumps(obj, ensure_ascii=True) + "\n")
    _OUT.flush()


def _add_dll_dirs():
    r"""
    Trên Windows, DLL chỉ được tìm thấy trong thư mục đang chạy hoặc thư mục đã
    đăng ký qua os.add_dll_directory(). PyInstaller đặt DLL ở _internal\ còn
    sidecar.exe nằm ở thư mục cha, mà Windows KHÔNG dò thư mục con -> không tìm
    thấy DLL.

    HAI BẪY Ở ĐÂY, CẢ HAI ĐỀU ĐÃ MẮC:
      1. os.add_dll_directory() trả về một HANDLE, và handle đó bị thu hồi ngay
         lập tức nếu ta không giữ lại. Giải phóng handle = gỡ thư mục khỏi
         đường dẫn tìm kiếm. Vì vậy phải giữ tham chiếu trong danh sách ở cấp
         module.
      2. Chỉ đăng ký _internal là chưa đủ; phải đăng ký cả thư mục chứa file exe.

    Phải chạy TRƯỚC mọi lệnh import nặng.
    """
    if os.name != "nt":
        return
    # Giữ handle sống: nếu không, thư mục bị gỡ khỏi đường dẫn tìm kiếm DLL.
    _dll_handles = []
    try:
        base = getattr(sys, "_MEIPASS", None) or os.path.dirname(sys.executable)
        candidates = [
            base,
            os.path.dirname(sys.executable),   # thư mục chứa sidecar.exe
            os.path.dirname(os.path.dirname(sys.executable)),
        ]
        for root_dir, dirs, _files in os.walk(base):
            for d in dirs:
                candidates.append(os.path.join(root_dir, d))
            if len(candidates) > 400:  # tránh quét quá nhiều
                break
        seen = set()
        for d in candidates:
            if d in seen or not os.path.isdir(d):
                continue
            seen.add(d)
            try:
                _dll_handles.append(os.add_dll_directory(d))
            except Exception:  # noqa: BLE001  # thư mục không dùng được -> bỏ qua
                pass
    except Exception:  # noqa: BLE001
        pass
    globals()["_DLL_HANDLES"] = _dll_handles  # giữ tham chiếu sống


_add_dll_dirs()


def log(msg):
    sys.stderr.write(f"[sidecar] {msg}\n")
    sys.stderr.flush()


# ---------------------------------------------------------------------------
# Model Whisper
# ---------------------------------------------------------------------------

# Dùng "small" mặc định. Xem config.js để biết vì sao chọn model này.
DEFAULT_MODEL = os.environ.get("LAY_DEFAULT_MODEL", "small")

# ctranslate2 KHÔNG hỗ trợ GPU trên macOS, int8 là lựa chọn duy nhất hợp lý
# cho cả Intel lẫn Apple Silicon. Trên Apple Silicon nó phân giải thành int8_float32.
COMPUTE_TYPE = "int8"

# Các model này CHỈ chạy tiếng Anh. Nếu đưa chúng vào danh sách "chạy được với
# tiếng Trung", faster-whisper sẽ không báo lỗi mà ra rác âm thầm — nên phải
# chặn ở tầng app.
ENGLISH_ONLY = {
    "tiny.en", "base.en", "small.en", "medium.en",
    "distil-small.en", "distil-medium.en",
    "distil-large-v3", "distil-large-v3.5", "distil-large-v2",
}

# Repo trên HuggingFace cho từng model.
MODEL_REPOS = {
    "tiny": "Systran/faster-whisper-tiny",
    "base": "Systran/faster-whisper-base",
    "small": "Systran/faster-whisper-small",
    "medium": "Systran/faster-whisper-medium",
    "large-v3": "Systran/faster-whisper-large-v3",
    "large": "Systran/faster-whisper-large-v3",
    "large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    "turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    "distil-large-v3": "Systran/faster-distil-whisper-large-v3",
    "distil-medium.en": "Systran/faster-distil-whisper-medium.en",
    "distil-small.en": "Systran/faster-distil-whisper-small.en",
}

# Prompt ép kiểu chữ. Đây là công cụ điều khiển Giản thể <-> Phồn thể.
# KHÔNG phải tăng độ chính xác, chỉ chuẩn hoá chữ viết — đã kiểm chứng hai chiều.
SCRIPT_PROMPTS = {
    "zh-Hans": "以下是简体中文的句子。",
    "zh-Hant": "以下為繁體中文的句子。",
}

_model_cache = {}
_model_cache_lock = threading.Lock()
# Các luồng ghi âm đang chạy, để main() chờ nếu stdin đóng lại.
_threads = set()
_threads_lock = threading.Lock()
_cancel_flags = {}
_cancel_lock = threading.Lock()


def set_cancel(job_id, value=True):
    with _cancel_lock:
        _cancel_flags[job_id] = value


def is_cancelled(job_id):
    with _cancel_lock:
        return _cancel_flags.get(job_id, False)


def load_model(model_name, models_dir):
    """Nạp model, cache lại để lần sau dùng lại (nạp lại tốn thời gian và RAM)."""
    with _model_cache_lock:
        if model_name in _model_cache:
            log(f"dung lai model da nap: {model_name}")
            return _model_cache[model_name]

        from faster_whisper import WhisperModel

        os.makedirs(models_dir, exist_ok=True)
        started = time.time()
        log(f"nap model: {model_name} (may tai ve neu chua co)")
        model = WhisperModel(
            model_name,
            device="cpu",
            compute_type=COMPUTE_TYPE,
            cpu_threads=max(1, (os.cpu_count() or 4)),
            download_root=models_dir,
            local_files_only=False,
        )
        _model_cache[model_name] = model
        log(f"nap xong {model_name} trong {time.time() - started:.1f}s")
        return model


def ensure_model(model_name, models_dir, job_id=None):
    """
    Dam bao model da co san tren dia, tai ve neu chua co va bao cao tien do.
    Tải riêng (thay vì để WhisperModel tự tải) để lấy được tiến độ theo byte
    và để huỷ được.
    """
    repo_id = MODEL_REPOS.get(model_name)
    if not repo_id:
        raise ValueError(f"Không rõ model '{model_name}'")

    marker = os.path.join(models_dir, f".ready-{model_name}")
    if os.path.exists(marker):
        return

    from huggingface_hub import snapshot_download

    target = os.path.join(models_dir, model_name)
    stop_flag = threading.Event()
    total_bytes = [0]

    def watch():
        """Theo dõi kich thuoc thu muc de bao cao tien do."""
        while not stop_flag.is_set():
            got = 0
            for root, _dirs, files in os.walk(target):
                for f in files:
                    try:
                        got += os.path.getsize(os.path.join(root, f))
                    except OSError:
                        pass
            total_bytes[0] = got
            if got:
                emit({
                    "event": "model_download",
                    "jobId": job_id,
                    "model": model_name,
                    "bytes": got,
                })
            stop_flag.wait(0.7)

    watcher = threading.Thread(target=watch, daemon=True)
    watcher.start()
    try:
        emit({"event": "model_download_start", "jobId": job_id, "model": model_name})
        snapshot_download(
            repo_id=repo_id,
            local_dir=target,
            allow_patterns=["model.bin", "config.json", "tokenizer.json", "vocabulary.*"],
        )
    finally:
        stop_flag.set()
        watcher.join(timeout=2)

    # Chỉ đánh dấu sẵn sàng khi file mo hinh thuc su ton tai.
    if not os.path.exists(os.path.join(target, "model.bin")):
        raise RuntimeError(f"Tải model {model_name} xong nhưng thiếu model.bin")
    with open(marker, "w") as fh:
        fh.write("ok")
    emit({"event": "model_download_done", "jobId": job_id, "model": model_name,
          "bytes": total_bytes[0]})


# ---------------------------------------------------------------------------
# Chuyen doi dau vao
# ---------------------------------------------------------------------------

def vad_available() -> bool:
    """onnxruntime (cho Silero VAD) có dùng được không?

    Đặt LAY_NO_VAD=1 để ép tắt, dùng để kiểm thử đúng tình huống máy người
    dùng gặp phải (thiếu onnxruntime) mà không cần cài lại Windows.
    """
    if os.environ.get("LAY_NO_VAD") == "1":
        return False
    try:
        import onnxruntime  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


def silence_boundaries(audio_path, opts):
    """Các mốc thời gian nên cắt audio, tìm bằng năng lượng RMS.

    Trả về (danh sách mốc cắt tính bằng giây, mảng âm thanh 16 kHz).
    """
    import numpy as np
    from faster_whisper.audio import decode_audio

    threshold_db = float(opts.get("silenceThresholdDb", -40))
    min_silence_ms = int(opts.get("minSilenceMs", 600))
    frame_len = 16000 // 50  # 20 ms

    audio = decode_audio(audio_path)
    n_frames = len(audio) // frame_len
    if n_frames < 3:
        return None, audio

    frames = audio[: n_frames * frame_len].reshape(n_frames, frame_len)
    rms = np.sqrt((frames.astype(np.float64) ** 2).mean(axis=1) + 1e-10)
    db = 20 * np.log10(rms)
    voiced = db > threshold_db
    del frames, rms

    frame_s = frame_len / 16000.0
    min_sil = min_silence_ms / 1000.0
    cuts = []
    run_start = None
    for i, v in enumerate(voiced):
        if not v and run_start is None:
            run_start = i
        elif v and run_start is not None:
            if (i - run_start) * frame_s >= min_sil:
                cuts.append(((run_start + i) / 2.0) * frame_s)
            run_start = None
    return cuts, audio


def transcribe_chunked(job_id, audio, cuts, model, kwargs):
    """Ghi âm từng đoạn ngắn rồi nối kết quả — không cần VAD.

    VÌ SAO CẦN:
    faster-whisper 1.2.1 chỉ bỏ qua yêu cầu clip_timestamps khi audio NGẮN HƠN
    30 giây:

        if vad_filter:                     clip_timestamps = get_speech_timestamps(...)
        elif duration < chunk_length:      clip_timestamps = [toàn bộ audio]
        else:  raise RuntimeError("No clip timestamps found. ...")

    Mà clip_timestamps truyền từ bên ngoài thì KHÔNG dùng được: tầng ngoài đòi
    kiểu dict {start,end}, còn tầng trong lại nhân với số -> "dict * int". Đó là
    lỗi của chính thư viện, không phải của app.

    Nên cách chắc chắn là tự chia đoạn ≤ 28 giây, cắt ở chỗ im lặng để không
    bị cắt giữa từ, gọi transcribe cho từng đoạn (mỗi đoạn < 30s nên không cần
    VAD) rồi cộng lệch timestamp.
    """
    sr = 16000
    max_len = int(28.0 * sr)
    pad = int(0.15 * sr)

    # kwargs do tầng trên gửi xuống đã có sẵn khoá 'vad_filter'; ở đây luôn
    # ép tắt, nên phải bỏ bản sao cũ đi tránh truyền trùng.
    chunk_kwargs = {k: v for k, v in kwargs.items() if k != "vad_filter"}
    chunk_kwargs["vad_filter"] = False

    bounds = [0] + [int(c * sr) for c in (cuts or [])] + [len(audio)]
    chunks = []
    for i in range(len(bounds) - 1):
        s = max(0, bounds[i] - (pad if i else 0))
        e = min(len(audio), bounds[i + 1] + pad)
        while e - s > max_len:  # khoảng im nào cũng phải cắt thêm
            chunks.append((s, s + max_len))
            s += max_len
        if e > s:
            chunks.append((s, e))

    if not chunks:
        chunks = [(0, len(audio))]

    log(f"khong co VAD — chia thành {len(chunks)} đoạn nhỏ")
    total = 0
    t0 = time.time()
    for idx, (s, e) in enumerate(chunks):
        if is_cancelled(job_id):
            return {"cancelled": True, "segments": total}
        offset = s / sr
        for seg in model.transcribe(audio[s:e], **chunk_kwargs)[0]:
            seg.start += offset
            seg.end += offset
            for w in (seg.words or []):
                w.start += offset
                w.end += offset
            emit({
                "event": "segment",
                "jobId": job_id,
                "index": total,
                "start": round(seg.start, 3),
                "end": round(seg.end, 3),
                "text": seg.text,
                "words": [
                    {"start": round(w.start, 3), "end": round(w.end, 3), "word": w.word}
                    for w in (seg.words or [])
                ],
            })
            total += 1
        emit({
            "event": "transcribe_progress",
            "jobId": job_id,
            "percent": int(((idx + 1) / len(chunks)) * 100),
            "elapsed": round(time.time() - t0, 1),
        })
    return {"cancelled": False, "segments": total, "chunks": len(chunks)}

def transcribe(job_id, audio_path, models_dir, opts):
    """
    Chay Whisper. `opts` la dict tu Electron.
    Ket qua duoc phat tung doan (segment) de giao dien khong phai cho het
    toan bo moi hien thi.
    """
    model_name = opts.get("model") or DEFAULT_MODEL
    language = opts.get("language") or "auto"
    if language == "auto":
        language = None
    script = opts.get("script") or ""
    task = opts.get("task") or "transcribe"
    beam_size = int(opts.get("beamSize", 5))
    vad_filter = bool(opts.get("vadFilter", True))
    batch_size = max(1, int(opts.get("batchSize", 4)))

    if model_name in ENGLISH_ONLY and language and language.startswith("zh"):
        raise ValueError(
            f"Model '{model_name}' chỉ hỗ trợ tiếng Anh. Hãy chọn một model có hỗ trợ "
            "tiếng Trung (small, medium, large-v3-turbo, large-v3)."
        )

    ensure_model(model_name, models_dir, job_id=job_id)
    model = load_model(model_name, models_dir)

    initial_prompt = None
    if script in SCRIPT_PROMPTS:
        initial_prompt = SCRIPT_PROMPTS[script]
    hotwords = opts.get("hotwords") or None

    emit({"event": "transcribe_start", "jobId": job_id, "model": model_name,
          "language": language or "auto", "task": task})

    # Tham so truyền xuống Whisper. GHI CHÚ: một số tham số có giá trị mặc định
    # KHÁC NHAU giữa WhisperModel.transcribe và BatchedInferencePipeline.transcribe
    # (ví dụ vad_filter mặc định False, without_timestamps mặc định False ở kiển
    # batched). Để khỏi sai, ta truyền TẤT CẢ tham số xuống rõ ràng ở cả hai nhánh.
    #
    # Nếu máy không có onnxruntime thì KHÔNG được tắt VAD trần trụi:
    # faster-whisper 1.2.1 sẽ ném "No clip timestamps found" với mọi audio trên
    # 30 giây. Thay vào đó tự chia đoạn nhỏ để không cần VAD.
    use_chunked = vad_filter and not vad_available()
    if use_chunked:
        log("VAD không dùng được (thiếu onnxruntime) — chia đoạn để ghi âm")

    kwargs = dict(
        language=language,
        task=task,
        beam_size=beam_size,
        # VAD loại bỏ khoảng lặng, giảm hiện tượng Whisper tự lặp lại
        # ("Thank you. Thank you. Thank you.") trên đoạn im.
        vad_filter=False if use_chunked else vad_filter,
        vad_parameters={"min_silence_duration_ms": 500},
        # Do nội bộ một lời, Whisper hay "tự nghĩ" lời trước đó vào lần sau
        # và làm các đoạn sau sai theo. Tắt đi là biện phòng "tự lặn".
        condition_on_previous_text=False,
        word_timestamps=bool(opts.get("wordTimestamps", True)),
        initial_prompt=initial_prompt,
        hotwords=hotwords,
    )

    t0 = time.time()
    if use_chunked:
        # Không có VAD: tự chia đoạn. Nhánh này tự phát sự kiện 'segment',
        # nên phải trả về ngay, không đi qua vòng lặp phía dưới.
        try:
            cuts, audio_arr = silence_boundaries(audio_path, opts)
        except Exception as exc:  # noqa: BLE001
            log(f"không dò được khoảng im lặng ({exc}) — chia đều")
            from faster_whisper.audio import decode_audio

            cuts, audio_arr = None, decode_audio(audio_path)
        out = transcribe_chunked(job_id, audio_arr, cuts, model, kwargs)
        if out.get("cancelled"):
            emit({"event": "cancelled", "jobId": job_id})
            return {"cancelled": True}
        emit({"event": "transcribe_progress", "jobId": job_id, "percent": 100,
              "elapsed": round(time.time() - t0, 1)})
        log(f"xong {out['segments']} đoạn trong {time.time() - t0:.1f}s "
            f"({out.get('chunks', 0)} đoạn nhỏ)")
        return {
            "cancelled": False,
            "segments": out["segments"],
            "elapsed": round(time.time() - t0, 1),
            "rtf": round((time.time() - t0) / max(0.1, len(audio_arr) / 16000), 3),
            "vad": "rms-chunked",
        }

    if batch_size > 1:
        # BatchedInferencePipeline xử lý nhiều đoạn cùng lúc -> nhanh gấp khoảng
        # 2 lần so với tuần tự. đổi lại một chút RAM.
        from faster_whisper import BatchedInferencePipeline

        pipeline = BatchedInferencePipeline(model=model)
        segments, info = pipeline.transcribe(audio_path, batch_size=batch_size, **kwargs)
    else:
        segments, info = model.transcribe(audio_path, **kwargs)

    duration = float(getattr(info, "duration", 0.0) or 0.0)
    emit({
        "event": "transcribe_info",
        "jobId": job_id,
        "language": getattr(info, "language", None),
        "languageProbability": float(getattr(info, "language_probability", 0.0) or 0.0),
        "duration": duration,
    })

    last_emitted_pct = -1
    count = 0
    for seg in segments:
        if is_cancelled(job_id):
            emit({"event": "cancelled", "jobId": job_id})
            return {"cancelled": True}

        words = []
        if getattr(seg, "words", None):
            words = [
                {"start": round(w.start, 3), "end": round(w.end, 3), "word": w.word}
                for w in seg.words
            ]
        emit({
            "event": "segment",
            "jobId": job_id,
            "index": count,
            "start": round(seg.start, 3),
            "end": round(seg.end, 3),
            "text": seg.text,
            "words": words,
        })
        count += 1

        if duration > 0:
            pct = int(min(99, (seg.end / duration) * 100))
            # Chi phat khi lech 1% de giam so tin nhan tu renderer.
            if pct > last_emitted_pct:
                last_emitted_pct = pct
                emit({
                    "event": "transcribe_progress",
                    "jobId": job_id,
                    "percent": pct,
                    "elapsed": round(time.time() - t0, 1),
                })

    elapsed = time.time() - t0
    rtf = (elapsed / duration) if duration else 0.0
    emit({"event": "transcribe_progress", "jobId": job_id, "percent": 100,
          "elapsed": round(elapsed, 1)})
    log(f"xong {count} doan trong {elapsed:.1f}s (rtf={rtf:.3f})")
    return {
        "cancelled": False,
        "segments": count,
        "elapsed": round(elapsed, 1),
        "rtf": round(rtf, 3),
    }


# ---------------------------------------------------------------------------
# Vong lap lenh
# ---------------------------------------------------------------------------

def handle(msg):
    cmd = msg.get("cmd")
    job_id = msg.get("jobId")

    if cmd == "ping":
        return {"ok": True, "pong": True, "pid": os.getpid()}

    if cmd == "env":
        info = {
            "python": sys.version.split()[0],
            "executable": sys.executable,
            "frozen": bool(getattr(sys, "frozen", False)),
        }
        try:
            import ctranslate2
            info["ctranslate2"] = ctranslate2.__version__
            info["computeTypes"] = sorted(
                ctranslate2.get_supported_compute_types("cpu", device_index=0)
            )
        except Exception as exc:  # noqa: BLE001
            info["ctranslate2_error"] = str(exc)
        try:
            import faster_whisper
            info["fasterWhisper"] = faster_whisper.__version__
        except Exception:  # noqa: BLE001
            info["fasterWhisper"] = None
        return {"ok": True, "env": info}

    if cmd == "download_model":
        ensure_model(msg.get("model") or DEFAULT_MODEL, msg["modelsDir"], job_id=job_id)
        return {"ok": True}

    if cmd == "cancel":
        # "targetJobId" la job can dung. "jobId" chi la id cua lenh huy.
        # Neu dung chung mot id, phia Electron se lam cho mat cho hieu ket qua
        # cua lenh ghi am dang chay.
        set_cancel(msg.get("targetJobId"), True)
        return {"ok": True}

    if cmd == "reset_cancel":
        set_cancel(job_id, False)
        return {"ok": True}

    if cmd == "transcribe":
        # KHONG xu ly o day. Xem run_transcribe() — viec ghi am phai chay
        # tren luong rieng, neu khong lenh huy se khong bao gio duoc doc.
        return {"deferred": True}

    return {"ok": False, "error": f"Lệnh không rõ: {cmd}"}


def run_transcribe(msg):
    """Chạy ghi âm trên một luong riêng.

    VÌ SAO PHẢI TÁCH LUONG:
    Vong lap doc stdin la noi duy nhat nhan lenh tu Electron. Neu chay ghi am
    ngay trong vong lap do, lenh `cancel` se nam khong trong ong den khi ghi am
    xong -> nut "Dung" tren giao dien khong bao gio co tac dung. Da xac nhan
    loi nay bang test: gui cancel luc 1 giay sau, van chay het 12/12 doan.
    """
    job_id = msg.get("jobId")

    def worker():
        try:
            result = transcribe(job_id, msg["audio"], msg["modelsDir"], msg.get("opts") or {})
            emit({"event": "result", "jobId": job_id, "ok": True, **result})
        except Exception as exc:  # noqa: BLE001
            log(traceback.format_exc())
            emit({
                "event": "result",
                "jobId": job_id,
                "ok": False,
                "error": str(exc),
                "traceback": traceback.format_exc()[-2000:],
            })

        with _threads_lock:
            _threads.discard(threading.current_thread())

    t = threading.Thread(target=worker, daemon=True, name=f"transcribe-{job_id}")
    with _threads_lock:
        _threads.add(t)
    t.start()


def main():
    log(f"khoi dong (python {sys.version.split()[0]}, frozen={bool(getattr(sys,'frozen',False))})")
    emit({"event": "ready", "pid": os.getpid()})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as exc:
            emit({"event": "error", "error": f"JSON không hợp lệ: {exc}"})
            continue

        job_id = msg.get("jobId")
        try:
            if msg.get("cmd") == "transcribe":
                run_transcribe(msg)
                continue
            result = handle(msg)
            result["jobId"] = job_id
            result["event"] = "result"
            emit(result)
        except Exception as exc:  # noqa: BLE001
            log(traceback.format_exc())
            emit({
                "event": "result",
                "jobId": job_id,
                "ok": False,
                "error": str(exc),
                "traceback": traceback.format_exc()[-2000:],
            })

    # stdin đã đóng. Nếu thoát ngay, các luồng ghi âm daemon đang chạy sẽ bị
    # giết giữa chừng và mất kết quả MÀ KHÔNG để lại dấu vết nào. Phải chờ.
    with _threads_lock:
        pending = list(_threads)
    if pending:
        log(f"stdin da dong, cho {len(pending)} luong ghi am chay tiep...")
    for t in pending:
        t.join(timeout=7200)  # tối đa 2 giờ cho một lượt ghi âm


if __name__ == "__main__":
    import multiprocessing

    # Bat buoc khi dong goi bang PyInstaller: ctranslate2/tokenizers tao SemLock,
    # khien multiprocessing khoi dong lai tien trinh va chay lai code cap
    # module nay trong tien trinh con. Khong co dong nay se bao loi
    # "Invalid model size 'from multiprocessing.resource_tracker import main;main(6)'".
    multiprocessing.freeze_support()
    main()
