const fs = require("fs");
const path = require("path");
const yaml = require("yaml");

const TAGS_PATH = path.join(__dirname, "..", "..", "config", "post_tags.yaml");

function loadPostTags() {
  const raw = fs.readFileSync(TAGS_PATH, "utf8");
  const parsed = yaml.parse(raw) || {};
  const postTags = Array.isArray(parsed.post_tags) ? parsed.post_tags : [];

  return postTags
    .map((tag) => {
      if (typeof tag === "string" && tag.trim().length > 0) {
        const label = tag.trim();
        return { id: label, label };
      }
      if (!tag || typeof tag !== "object") {
        return null;
      }
      const id = typeof tag.id === "string" && tag.id.trim().length > 0 ? tag.id.trim() : "";
      const label = typeof tag.label === "string" && tag.label.trim().length > 0 ? tag.label.trim() : "";
      if (!id || !label) {
        return null;
      }
      return { id, label };
    })
    .filter(Boolean);
}

function createPostTagsHandler({ sendJson }) {
  return function handlePostTags(req, res) {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    try {
      const tags = loadPostTags();
      sendJson(res, 200, {
        success: true,
        count: tags.length,
        tags,
      });
    } catch (err) {
      console.error("[post_tags] load_error:", err.message);
      sendJson(res, 500, { error: "post_tags_unavailable" });
    }
  };
}

module.exports = createPostTagsHandler;
