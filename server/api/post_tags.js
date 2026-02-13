const fs = require("fs");
const path = require("path");
const yaml = require("yaml");

const TAGS_PATH = path.join(__dirname, "..", "..", "config", "post_tags.yaml");

function normalizePostTags(rawTags) {
  const postTags = Array.isArray(rawTags) ? rawTags : [];

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

function loadPostTags() {
  const raw = fs.readFileSync(TAGS_PATH, "utf8");
  const parsed = yaml.parse(raw) || {};
  return normalizePostTags(parsed.post_tags);
}

function loadPostTagsDocument() {
  const raw = fs.readFileSync(TAGS_PATH, "utf8");
  const parsed = yaml.parse(raw) || {};
  const tags = normalizePostTags(parsed.post_tags);
  return { parsed, tags };
}

function getNextTagId(tags) {
  const maxNumericId = tags.reduce((max, tag) => {
    const value = Number.parseInt(tag.id, 10);
    if (Number.isInteger(value) && value > max) {
      return value;
    }
    return max;
  }, 0);
  return String(maxNumericId + 1);
}

function savePostTags(tags) {
  const payload = {
    post_tags: tags.map((tag) => ({ id: tag.id, label: tag.label })),
  };
  fs.writeFileSync(TAGS_PATH, yaml.stringify(payload), "utf8");
}

function parseJsonBody(req, callback) {
  let done = false;
  const finish = (err, payload) => {
    if (done) {
      return;
    }
    done = true;
    callback(err, payload);
  };

  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 1024 * 1024) {
      finish(new Error("payload_too_large"));
      req.destroy();
    }
  });
  req.on("end", () => {
    if (!body) {
      finish(null, {});
      return;
    }
    try {
      finish(null, JSON.parse(body));
    } catch {
      finish(new Error("invalid_json"));
    }
  });
  req.on("error", (err) => {
    finish(err);
  });
}

function createPostTagsHandler({ sendJson }) {
  return function handlePostTags(req, res) {
    if (req.method === "GET") {
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
      return;
    }

    if (req.method === "POST") {
      parseJsonBody(req, (parseErr, body) => {
        if (parseErr) {
          sendJson(res, 400, { error: parseErr.message === "payload_too_large" ? "payload_too_large" : "invalid_json" });
          return;
        }

        const label = typeof body.label === "string" ? body.label.trim() : "";
        if (!label) {
          sendJson(res, 400, { error: "invalid_label" });
          return;
        }

        try {
          const { tags } = loadPostTagsDocument();
          const existing = tags.find((tag) => tag.label === label);
          if (existing) {
            sendJson(res, 200, { success: true, created: false, tag: existing, count: tags.length });
            return;
          }

          const newTag = {
            id: getNextTagId(tags),
            label,
          };
          const nextTags = [...tags, newTag];
          savePostTags(nextTags);
          sendJson(res, 201, { success: true, created: true, tag: newTag, count: nextTags.length });
        } catch (err) {
          console.error("[post_tags] save_error:", err.message);
          sendJson(res, 500, { error: "post_tags_save_failed" });
        }
      });
      return;
    }

    sendJson(res, 405, { error: "method_not_allowed" });
  };
}

module.exports = createPostTagsHandler;
