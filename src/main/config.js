'use strict';

/**
 * Cấu hình tập trung — file này thuần JS, KHÔNG import electron,
 * để test script và sidecar Python có thể dùng chung.
 */

// ---------------------------------------------------------------------------
// yt-dlp
// ---------------------------------------------------------------------------

/**
 * Thang định dạng âm thanh.
 *
 * KHÔNG BAO GIỜ hardcode một định dạng đơn lẻ.
 * YouTube liên tục bỏ định dạng cũ: tháng 3/2026 toàn bộ DASH audio-only biến mất
 * (yt-dlp#16128), tháng 1/2026 format 140 biến mất với một số video (#15756).
 * Dùng thang bậc thì khi 140 biến mất yt-dlp tự rơi xuống 251 thay vì báo lỗi.
 * 140 (AAC trong mp4) đứng đầu vì là một file duy nhất, không cần remux.
 */
const AUDIO_FORMAT_LADDER = '140/251/233/234/bestaudio';

/**
 * Client nào dùng khi không có cookie.
 * `default` = visionos,web (tính đến 2026-08). Cố tình KHÔNG hardcode
 * `visionos` để khi YouTube xoay vòng client, app tự đi theo.
 */
const PLAYER_CLIENT = 'default';

/** Nghỉ giữa các request để không bị YouTube giới hạn (~300 video/giờ khi khách). */
const SLEEP_REQUESTS = '1';
const SLEEP_INTERVAL = '1';

/** Asset tải về cho từng nền tảng, theo tên trong release của yt-dlp. */
const YTDLP_ASSET = {
  darwin: 'yt-dlp_macos', // universal binary, chạy được cả Intel lẫn Apple Silicon
  win32: 'yt-dlp.exe',
  linux: 'yt-dlp',
};

/** Repo chính thức (bản phát hành theo tháng). */
const YTDLP_REPO = 'yt-dlp/yt-dlp';
/** Repo nightly — README của yt-dlp khuyến nghị dùng kênh này cho người dùng. */
const YTDLP_NIGHTLY_REPO = 'yt-dlp/yt-dlp-nightly-builds';

/**
 * Các phiên bản từng được xác nhận chạy được với YouTube.
 * Người dùng cần cơ chế "bản nào cũng chạy được" — nếu bản mới hỏng,
 * app có thể quay lại đúng các mốc này.
 */
const YTDLP_KNOWN_GOOD = [
  { version: '2026.08.19', note: 'Bản ổn định mới nhất, đã kiểm thử 2026-09-26' },
  { version: '2026.07.04', note: 'Dự phòng' },
];

/** Phiên bản bundle sẵn trong installer. Mỗi lần build app ta kiểm thử lại. */
const YTDLP_BUNDLED_VERSION = '2026.08.19';

/**
 * Video dùng để kiểm tra sống trước khi áp dụng bản yt-dlp mới.
 *
 * CÓ NHIỀU VIDEO DỰ PHÒNG — đây là điểm mấu chốt. Ban đầu app dùng
 * `BaW_jenozKc` (video 10 giây mà yt-dlp dùng trong test của họ) nhưng
 * video đó ĐÃ KHÔNG CÒN TRUY CẬP ĐƯỢC. Nếu chỉ dùng một video, tính năng
 * "tự cập nhật" sẽ hỏng vĩnh viễn và không bao giờ tự sửa được — người
 * dùng cũng không còn cách nào khác ngoài việc cài tay.
 *
 * Thứ tự ưu tiên: video càng ngắn càng tốt (kiểm tra nhanh), và càng "phổ
 * biến lâu dài" càng tốt (ít bị gỡ nhất).
 */
const VERIFY_VIDEOS = [
  'https://www.youtube.com/watch?v=jNQXAC9IVRw', // 19s, video đầu tiên của YouTube
  'https://www.youtube.com/watch?v=9bZkp7q19f0', // 252s
  'https://www.youtube.com/watch?v=aircAruvnKk', // 1120s
];

// ---------------------------------------------------------------------------
// Whisper / faster-whisper
// ---------------------------------------------------------------------------

/**
 * compute_type='int8' trên cả CPU Intel lẫn Apple Silicon.
 * Trên Apple Silicon, int8 phân giải thành int8_float32 (backend Ruy) —
 * KHÔNG có GPU/Metal nào trong CTranslate2. float16 trên Mac sẽ lặng lẽ
 * rơi về float32, tốn gấp đôi RAM mà không nhanh hơn.
 */
const COMPUTE_TYPE = 'int8';

const DEFAULT_MODEL = 'medium';

/** Mô hình ENGLISH-ONLY, sẽ cho ra rác khi gặp tiếng Trung mà KHÔNG báo lỗi. */
const ENGLISH_ONLY_MODELS = new Set([
  'tiny.en',
  'base.en',
  'small.en',
  'medium.en',
  'distil-small.en',
  'distil-medium.en',
  'distil-large-v3',
  'distil-large-v3.5',
  'distil-large-v2',
]);

/**
 * Bảng model. Dung lượng là kích thước tải về (model.bin đã lượng tử int8).
 * tốc_độ = số lần NHANH HƠN thời gian thực, đo thật trên M1 Pro 8 nhân:
 * int8, VAD, beam 5, CÓ BATCH (batch_size=4). Có tính đến cả tỉ lệ lỗi ký tự
 * (CER) trên tiếng Trung đã đo.
 *
 * Lưu ý: số lần nhanh hơn đo được ở đây KHÁC với con số của chính dự án
 * faster-whisper, vì nhánh batch cho kết quả nhanh hơn hẳn khi chạy tuần tự.
 * Với `small` đo được RTF 0.145 (batched) so với 0.296 (không batch).
 */
const MODELS = [
  {
    id: 'tiny',
    label: 'Rất nhanh',
    sizeMB: 78,
    speed: '~30x',
    quality: 2,
    note: 'Rất nhỏ và nhanh nhất, nhưng tiếng Trong sai nhiều. Chỉ nên dùng để thử app.',
  },
  {
    id: 'base',
    label: 'Nhanh',
    sizeMB: 148,
    speed: '~20x',
    quality: 3,
    note: 'Nhẹ, chạy mượt trên máy yếu. Tiếng Trong vẫn khá lỗi.',
  },
  {
    id: 'small',
    label: 'Nhẹ và nhanh',
    sizeMB: 486,
    speed: '~7x',
    quality: 3,
    note: 'Nhỏ nhất trong nhóm dùng được, 1 giờ video mất khoảng 9 phút trên máy M-series. Chọn nếu máy yếu hoặc cần chạy nhanh.',
  },
  {
    id: 'medium',
    label: 'Chất lượng cao',
    sizeMB: 1531,
    speed: '~2.5x',
    quality: 4,
    recommended: true,
    note: 'Mặc định của app. Cân bằng giữa độ chính xác và tốc độ, dùng tốt cho cả tiếng Anh lẫn tiếng Trung. Cần khoảng 2.5 GB RAM trống.',
  },
  {
    id: 'large-v3-turbo',
    label: 'Tốt nhất',
    sizeMB: 1621,
    speed: '~4x',
    quality: 5,
    note: 'Chất lượng tốt nhất trong nhóm này, nhất là tiếng Trung. 1 giờ video mất khoảng 15 phút, cần khoảng 2.5GB RAM trống.',
  },
  {
    id: 'large-v3',
    label: 'Chuyên sâu',
    sizeMB: 3091,
    speed: '~1.2x',
    quality: 5,
    note: 'Mô hình lớn nhất, chậm hơn thời gian thực trên CPU. Chỉ dùng khi cần chất lượng tuyệt đối và không ngại chờ.',
  },
];

/**
 * Prompt ép kiểu chữ. Đây là cách điều khiển đầu ra
 * Giản thể ↔ Phồn thể — KHÔNG phải tăng độ chính xác, chỉ chuẩn hoá chữ viết.
 * Đã kiểm chứng thực tế: cùng một đoạn audio, prompt Giản thể cho ra Giản thể
 * và ngược lại, hai chiều đều đúng.
 */
const SCRIPT_PROMPTS = {
  'zh-Hans': '以下是简体中文的句子。',
  'zh-Hant': '以下為繁體中文的句子。',
};

/**
 * Ngôn ngữ. Mã ISO 639-1, tên hiển thị bằng tiếng Việt.
 * Danh sách đầy đủ ở bên dưới; nhóm "chính" là những thứ hay dùng nhất.
 */
const LANGUAGES = [
  { code: 'auto', name: 'Tự động nhận diện', primary: true },
  { code: 'en', name: 'Tiếng Anh', primary: true },
  { code: 'zh', name: 'Tiếng Trung (Quan tâm)', primary: true },
  { code: 'vi', name: 'Tiếng Việt' },
  { code: 'ja', name: 'Tiếng Nhật' },
  { code: 'ko', name: 'Tiếng Hàn Quốc' },
  { code: 'fr', name: 'Tiếng Pháp' },
  { code: 'de', name: 'Tiếng Đức' },
  { code: 'es', name: 'Tiếng Tây Ban Nha' },
  { code: 'pt', name: 'Tiếng Bồ Đào Nha' },
  { code: 'it', name: 'Tiếng Ý' },
  { code: 'ru', name: 'Tiếng Nga' },
  { code: 'tr', name: 'Tiếng Thổ Nhĩ Kỳ' },
  { code: 'ar', name: 'Tiếng Ả Rập' },
  { code: 'hi', name: 'Tiếng Hindi' },
  { code: 'id', name: 'Tiếng Indonesia' },
  { code: 'ms', name: 'Tiếng Mã Lai' },
  { code: 'th', name: 'Tiếng Thái' },
  { code: 'nl', name: 'Tiếng Hà Lan' },
  { code: 'pl', name: 'Tiếng Ba Lan' },
  { code: 'uk', name: 'Tiếng Ukraine' },
  { code: 'cs', name: 'Tiếng Séc' },
  { code: 'sv', name: 'Tiếng Thụy Điển' },
  { code: 'fi', name: 'Tiếng Phần Lan' },
  { code: 'da', name: 'Tiếng Đan Mạch' },
  { code: 'no', name: 'Tiếng Na Uy' },
  { code: 'he', name: 'Tiếng Hebrew' },
  { code: 'fa', name: 'Tiếng Ba Tư' },
  { code: 'el', name: 'Tiếng Hy Lạp' },
  { code: 'hu', name: 'Tiếng Hungary' },
  { code: 'ro', name: 'Tiếng Romania' },
  { code: 'bg', name: 'Tiếng Bulgaria' },
  { code: 'sr', name: 'Tiếng Serbia' },
  { code: 'hr', name: 'Tiếng Croatia' },
  { code: 'sk', name: 'Tiếng Slovak' },
  { code: 'sl', name: 'Tiếng Slovenia' },
  { code: 'lt', name: 'Tiếng Lithuania' },
  { code: 'lv', name: 'Tiếng Latvia' },
  { code: 'et', name: 'Tiếng Estonia' },
  { code: 'ca', name: 'Tiếng Catalan' },
  { code: 'eu', name: 'Tiếng Basque' },
  { code: 'gl', name: 'Tiếng Galicia' },
  { code: 'bn', name: 'Tiếng Bengali' },
  { code: 'ta', name: 'Tiếng Tamil' },
  { code: 'te', name: 'Tiếng Telugu' },
  { code: 'mr', name: 'Tiếng Marathi' },
  { code: 'ur', name: 'Tiếng Urdu' },
  { code: 'sw', name: 'Tiếng Swahili' },
  { code: 'af', name: 'Tiếng Afrikaans' },
];

/** Ngôn ngữ dùng để dịch (task='translate' của Whisper, dịch sang tiếng Anh). */
const TRANSLATE_TO = 'en';

module.exports = {
  AUDIO_FORMAT_LADDER,
  PLAYER_CLIENT,
  SLEEP_REQUESTS,
  SLEEP_INTERVAL,
  YTDLP_ASSET,
  YTDLP_REPO,
  YTDLP_NIGHTLY_REPO,
  YTDLP_KNOWN_GOOD,
  YTDLP_BUNDLED_VERSION,
  VERIFY_VIDEOS,
  COMPUTE_TYPE,
  DEFAULT_MODEL,
  ENGLISH_ONLY_MODELS,
  MODELS,
  SCRIPT_PROMPTS,
  LANGUAGES,
  TRANSLATE_TO,
};
