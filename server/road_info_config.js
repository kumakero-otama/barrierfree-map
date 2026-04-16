const fs = require("fs");
const path = require("path");
const yaml = require("yaml");

const ROAD_INFO_CONFIG_PATH = path.join(__dirname, "..", "config", "road_info.yaml");
// 画像上限が設定されていない場合でも、過大アップロードを避けるため 2MB を既定値にする。
const DEFAULT_MAX_IMAGE_BYTES = 2 * 1024 * 1024;

// 道情報投稿用設定を読み込み、未設定時は安全なデフォルト値を返す。
function loadRoadInfoConfig() {
  try {
    const raw = fs.readFileSync(ROAD_INFO_CONFIG_PATH, "utf8");
    const parsed = yaml.parse(raw) || {};
    const maxBytes = Number(parsed?.road_info?.image_max_bytes);
    const imageMaxBytes = Number.isFinite(maxBytes) && maxBytes > 0
      ? Math.floor(maxBytes)
      : DEFAULT_MAX_IMAGE_BYTES;
    return {
      imageMaxBytes,
      source: "yaml",
    };
  } catch {
    return {
      imageMaxBytes: DEFAULT_MAX_IMAGE_BYTES,
      source: "default",
    };
  }
}

module.exports = {
  loadRoadInfoConfig,
  DEFAULT_MAX_IMAGE_BYTES,
};
