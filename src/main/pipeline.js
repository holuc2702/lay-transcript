'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const C = require('./config');
const paths = require('./paths');
const ytdlpMgr = require('./ytdlp');
const jobs = require('./jobs');
const exporters = require('./exporters');
const settings = require('./settings');
const { Worker } = require('./worker');
const history = require('./history');
const translate = require('./translate');

/** 3720 -> "1 giờ 2 phút". Dùng để báo trước thời lượng cho người dùng. */
/** Báo cho renderer biết lịch sử đã đổi. */
let broadcastHistory = () => {};
function setHistoryBroadcaster(fn) {
  broadcastHistory = fn;
}

function fmtMinutes(seconds) {
  const s = Math.round(Number(seconds) || 0);
  if (s < 60) return `${s} giây`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} phút`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h} giờ ${rm} phút` : `${h} giờ`;
}


/**
 * Dieu phe toan bo qua trinh cho MOT video:
 *   tai audio -> chuan hoa -> ghi am -> xuat file
 *
 * Mot lan chay, nhieu video deu duoc xep hang va chay ke nhau (mac dinh 1 luc),
 * vi tai model Whisper ton RAM. Concurrent > 1 chi huu ich o buoc tai audio.
 */
class Pipeline {
  constructor(emit) {
    this.emit = emit;
    this.worker = new Worker(emit);
    this.queue = [];
    this.active = null;
    // Job đã xong vẫn phải được giữ lại trong bộ nhớ: nếu không, nút
    // "Xem transcript" và chức năng xuất file sẽ không tìm thấy dữ liệu
    // ngay sau khi job kết thúc. Giới hạn số lượng để không tràn bộ nhớ
    // (mỗi job có thể chứa hàng nghìn đoạn).
    this.finished = [];
    this.cancelled = new Set();
  }

  /** Tìm một job ở bất kỳ trạng thái nào. */
  findJob(jobId) {
    if (this.active && this.active.id === jobId) return this.active;
    return this.queue.find((j) => j.id === jobId) || this.finished.find((j) => j.id === jobId) || null;
  }

  /** Tất cả job, mới nhất trước. */
  allJobs() {
    return [...(this.active ? [this.active] : []), ...this.queue, ...this.finished];
  }

  setConcurrency() {
    // Co y chu dong so jobs chay cung luc: model Whisper nam trong RAM
    // (small ~1GB, large-v3 ~2.5GB) va tai mot lan la du dung cho nhieu
    // video. Chay song song chi lam cham moi job va co nguy co tran RAM.
    this.concurrency = 1;
    this.#drain();
  }

  add(url, overrides = {}) {
    const job = {
      id: randomUUID(),
      url: String(url || '').trim(),
      opts: { ...settings.get(), ...overrides },
      state: 'queued',
      progress: 0,
      message: 'Đang chờ…',
      segments: [],
      info: null,
      result: null,
      error: null,
      startedAt: null,
      finishedAt: null,
    };
    this.queue.push(job);
    this.#drain();
    return job;
  }

  cancel(jobId) {
    if (this.active && this.active.id === jobId) {
      this.cancelled.add(jobId);
      // `targetJobId` = job can dung. Khong dung `jobId` de tranh lam cho
      // mat cho hieu dang cho ket qua cua lenh ghi am.
      this.worker.send({ cmd: 'cancel', targetJobId: jobId }).catch(() => {});
      this.#say(this.active, { state: 'cancelling', message: 'Đang dừng lại…' });
      return true;
    }
    const idx = this.queue.findIndex((j) => j.id === jobId);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
      this.#say(this.queue[idx] ?? { id: jobId }, { state: 'cancelled' });
      return true;
    }
    return false;
  }

  cancelAll() {
    this.queue = [];
    if (this.active) this.cancel(this.active.id);
  }

  list() {
    return this.allJobs().map((j) => this.#view(j));
  }

  get(jobId) {
    const j = this.findJob(jobId);
    return j ? this.#view(j) : null;
  }

  /** Giữ lại job đã kết thúc để người dùng vẫn xem / xuất được. */
  #retain(job) {
    this.finished.unshift(job);
    while (this.finished.length > 50) this.finished.pop();
  }

  #view(j) {
    return {
      id: j.id,
      url: j.url,
      state: j.state,
      progress: j.progress,
      message: j.message,
      info: j.info,
      result: j.result,
      error: j.error,
      outputs: j.outputs || null,
      title: j.title || null,
      titleVi: j.titleVi || null,
      uploader: j.uploader || null,
      videoDuration: j.videoDuration ?? null,
      segmentCount: j.segments.length,
    };
  }

  #say(job, patch) {
    Object.assign(job, patch);
    this.emit({ type: 'job', job: this.#view(job), segments: job.segments.length });
  }

  #progress(job, patch) {
    Object.assign(job, patch);
    this.emit({ type: 'job', job: this.#view(job) });
  }

  #drain() {
    if (this.active || !this.queue.length) return;
    const job = this.queue.shift();
    this.active = job;
    this.#run(job)
      .catch((e) => {
        // #run tu bat moi loi, day la luoi an cho an toan.
        process.stderr.write(`[pipeline] loi khong mong doi: ${e.stack}\n`);
      })
      .finally(() => {
        // Giữ lại job để người dùng xem transcript và xuất file.
        this.#retain(job);
        this.active = null;
        this.#drain();
      });
  }

  async #run(job) {
    job.startedAt = new Date().toISOString();
    this.#say(job, { state: 'starting', progress: 0, message: 'Đang bắt đầu…' });

    const workDir = paths.writableDir('work', job.id);
    let audioRaw = null;
    let audioNorm = null;

    try {
      const { path: bin } = await ytdlpMgr.ensureInstalled();

      // --- 0. Thông tin video (tên + thời lượng) --------------------------------
      // Hỏi trước khi tải: biết tên ngay để đặt tên file cho đẹp, và biết
      // thời lượng để người dùng biết phải chờ bao lâu.
      // Không lấy được thì bỏ qua — không được để nó làm hỏng cả việc tải.
      try {
        const meta = await jobs.fetchMetadata(bin, job.url);
        if (meta) {
          job.title = meta.title;
          job.uploader = meta.uploader;
          job.videoDuration = meta.duration;
          this.#progress(job, {
            message: meta.duration
              ? `Đang chuẩn bị: video dài ${fmtMinutes(meta.duration)}`
              : 'Đang chuẩn bị…',
          });
        }

        // Dịch tiêu đề sang tiếng Việt (mặc định bật, tắt được trong Cài đặt).
        // Chạy SONG SONG với việc tải audio nên không phải chờ thêm.
        if (job.opts.translateTitle && job.title) {
          job._titlePromise = translate
            .toVietnamese(job.title)
            .then((r) => {
              if (r.text && r.text !== job.title) {
                job.titleVi = r.text;
                this.#progress(job, {});
              }
            })
            .catch(() => {});
        }
      } catch {
        /* im lặng bỏ qua */
      }

      // --- 1. Tai audio --------------------------------------------------
      this.#progress(job, { state: 'downloading', message: 'Đang tải audio từ YouTube…' });
      audioRaw = await jobs.downloadAudio(bin, job.url, {
        cookiesFile: job.opts.useCookies && job.opts.cookiesFile ? job.opts.cookiesFile : null,
        onProgress: (p) => {
          if (p.phase === 'download') {
            this.#progress(job, {
              progress: Math.round((p.percent ?? 0) * 0.15),
              message: p.message || `Đang tải audio… ${Math.round(p.percent ?? 0)}%`,
            });
          }
        },
      });

      // --- 2. Chuan hoa bang ffmpeg -------------------------------------
      this.#progress(job, { state: 'converting', progress: 15, message: 'Đang chuẩn hoá audio…' });
      audioNorm = path.join(workDir, 'audio16k.wav');
      await jobs.normalizeAudio(audioRaw, audioNorm, () =>
        this.#progress(job, { state: 'converting', progress: 15 })
      );

      // --- 3. Whisper ----------------------------------------------------
      job.state = 'transcribing';
      job.progress = 20;
      job.segments = [];
      this.#progress(job, { state: 'transcribing', progress: 20, message: 'Đang nhận diện giọng nói…' });

      const t = ytdlpMgr.modelsPath();
      const onSidecar = (ev) => {
        if (ev.jobId !== job.id) return;        switch (ev.event) {
          case 'model_download_start':
            this.#progress(job, { message: `Đang tải model Whisper (${ev.model})…` });
            break;
          case 'model_download':
            this.#progress(job, {
              message: `Đang tải model Whisper (${(ev.bytes / 1048576).toFixed(0)} MB)…`,
            });
            break;
          case 'transcribe_info':
            job.info = {
              language: ev.language,
              languageProbability: ev.languageProbability,
              duration: ev.duration,
            };
            break;
          case 'segment':
            job.segments.push({
              start: ev.start,
              end: ev.end,
              text: ev.text,
              words: ev.words,
            });
            break;
          case 'transcribe_progress': {
            // 20% la tai + chuan hoa, 75% la ghi am, 5% la xuat file.
            const p = 20 + Math.round((ev.percent ?? 0) * 0.75);
            this.#progress(job, {
              progress: Math.min(95, p),
              message: `Đang nhận diện giọng nói… ${ev.percent ?? 0}%`,
              info: job.info,
            });
            break;
          }
          default:
            break;
        }
      };

      const off = this.worker.on(onSidecar);
      try {
        const res = await this.worker.send(
          {
            cmd: 'transcribe',
            jobId: job.id,
            audio: audioNorm,
            modelsDir: t,
            opts: {
              model: job.opts.model,
              language: job.opts.language,
              script: job.opts.script,
              task: job.opts.task,
              beamSize: job.opts.beamSize,
              vadFilter: job.opts.vadFilter,
              wordTimestamps: job.opts.wordTimestamps,
              batchSize: job.opts.batchSize,
              hotwords: job.opts.hotwords,
            },
          },
          { timeout: 0 }
        );
        job.result = res;
      } finally {
        off();
      }

      if (this.cancelled.has(job.id)) {
        this.cancelled.delete(job.id);
        this.#say(job, { state: 'cancelled', message: 'Đã dừng lại.' });
        return;
      }

      if (!job.segments.length) {
        this.#say(job, {
          state: 'error',
          error:
            'Không nhận diện được lời nào trong audio.\n' +
            'Video có thể không có tiếng nói, hoặc tiếng quá nhỏ / không rõ.',
        });
        return;
      }

      // --- 4. Xuat file --------------------------------------------------
      this.#progress(job, { state: 'saving', progress: 96, message: 'Đang lưu file…' });
      const outputs = this.#writeOutputs(job);
      job.outputs = outputs;

      // Chờ nốt lệnh dịch tiêu đề (nếu đang chạy) rồi mới ghi lịch sử, để mục
      // lưu kèm cả tiêu đề tiếng Việt.
      if (job._titlePromise) {
        await job._titlePromise.catch(() => {});
        job._titlePromise = null;
      }

      this.#say(job, {
        state: 'done',
        progress: 100,
        message: `Xong — ${job.segments.length} đoạn.`,
        finishedAt: new Date().toISOString(),
      });
      this.#toHistory(job);
    } catch (err) {
      if (this.cancelled.has(job.id)) {
        this.cancelled.delete(job.id);
        this.#say(job, { state: 'cancelled', message: 'Đã dừng lại.' });
        return;
      }
      this.#say(job, {
        state: 'error',
        error: err.message,
        finishedAt: new Date().toISOString(),
      });
    } finally {
      // Don dep. Giu lai file wav neu nguoi dung muon dung lai/transcribe lai.
      if (!job.opts.keepAudio) {
        for (const f of [audioRaw, audioNorm]) {
          if (f) {
            try {
              fs.rmSync(f, { force: true });
            } catch {
              /* thuong bo qua */
            }
          }
        }
        try {
          fs.rmSync(workDir, { recursive: true, force: true });
        } catch {
          /* thuong bo qua */
        }
      }
    }
  }

  /** Ghi một mục vào lịch sử. Lỗi lưu không được làm hỏng job đã xong. */
  #toHistory(job) {
    try {
      history.add({
        id: job.id,
        url: job.url,
        title: job.title,
        titleVi: job.titleVi,
        uploader: job.uploader,
        duration: job.videoDuration,
        language: job.info?.language,
        model: job.opts.model,
        segmentCount: job.segments.length,
        rtf: job.result?.rtf,
        state: job.state,
        error: job.error,
        outputs: job.outputs,
      });
      broadcastHistory();
    } catch (err) {
      process.stderr.write(`[pipeline] không lưu lịch sử: ${err.message}\n`);
    }
  }

  /** Ghi transcript ra mấy file, dùng tên video làm tên file. */
  #writeOutputs(job) {
    const dir = settings.getOutputDir();
    fs.mkdirSync(dir, { recursive: true });

    const meta = {
      title: job.title || null,
      url: job.url,
      language: job.info?.language || null,
      model: job.opts.model,
      createdAt: new Date().toISOString(),
      rtf: job.result?.rtf ?? null,
    };

    const base = exporters.safeFilename(job.title || `transcript-${job.id.slice(0, 8)}`);
    const written = [];
    for (const [fmt, spec] of Object.entries(exporters.FORMATS)) {
      // Bo qua bien the txt khi nguoi dung chi chon mot dang.
      if (job.opts.formats && !job.opts.formats.includes(fmt)) continue;
      const ext = fmt === 'txtPlain' ? 'txt' : spec.ext;
      const name = `${base}.${ext}`;
      let full = path.join(dir, name);
      // Khong ghi de: them hau to -(2), -(3)…
      let n = 2;
      while (fs.existsSync(full)) {
        full = path.join(dir, `${base} (${n}).${ext}`);
        n += 1;
      }
      fs.writeFileSync(full, spec.fn(job.segments, {}, meta), 'utf8');
      written.push(full);
    }
    return written;
  }
}

module.exports = { Pipeline, setHistoryBroadcaster };
