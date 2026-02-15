const detailLoadingEl = document.getElementById("detail-loading");
const detailContentEl = document.getElementById("detail-content");
const detailErrorEl = document.getElementById("detail-error");
const tagsListEl = document.getElementById("tags-list");
const postsListEl = document.getElementById("posts-list");
const postCountEl = document.getElementById("post-count");
const backBtn = document.getElementById("back-btn");
const postSelfBtn = document.getElementById("post-self-btn");

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(dateRaw) {
  const date = new Date(dateRaw);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${y}/${m}/${d} ${hh}:${mm}`;
}

function setError(message) {
  if (detailLoadingEl) {
    detailLoadingEl.classList.add("hidden");
  }
  if (detailContentEl) {
    detailContentEl.classList.add("hidden");
  }
  if (detailErrorEl) {
    detailErrorEl.textContent = message;
    detailErrorEl.classList.remove("hidden");
  }
}

function renderTags(tags) {
  if (!tagsListEl) {
    return;
  }
  if (!Array.isArray(tags) || tags.length < 1) {
    tagsListEl.innerHTML = "<li>なし</li>";
    return;
  }
  tagsListEl.innerHTML = tags
    .map((tag) => `<li>${escapeHtml(tag && tag.labelJa)}</li>`)
    .join("");
}

function renderPosts(posts) {
  if (!postsListEl) {
    return;
  }
  const safePosts = Array.isArray(posts) ? posts : [];
  if (postCountEl) {
    postCountEl.textContent = `(全${safePosts.length}件)`;
  }
  if (safePosts.length < 1) {
    postsListEl.innerHTML = '<div class="post-card">投稿はまだありません。</div>';
    return;
  }

  postsListEl.innerHTML = safePosts
    .map((post) => {
      const media = Array.isArray(post.media) ? post.media : [];
      const mediaHtml = media
        .map((item) => `<img src="${escapeHtml(item.url)}" alt="投稿画像" loading="lazy" />`)
        .join("");
      return `
        <article class="post-card">
          <div class="post-head">
            <img class="avatar-img" src="/assets/account_default.png" alt="アカウント" />
            <span>${escapeHtml(formatDate(post.createdAt))}</span>
          </div>
          <div class="post-body">${escapeHtml(post.body)}</div>
          <div class="media-list">${mediaHtml}</div>
        </article>
      `;
    })
    .join("");
}

function showContent() {
  if (detailLoadingEl) {
    detailLoadingEl.classList.add("hidden");
  }
  if (detailErrorEl) {
    detailErrorEl.classList.add("hidden");
  }
  if (detailContentEl) {
    detailContentEl.classList.remove("hidden");
  }
}

function initActions() {
  if (postSelfBtn) {
    postSelfBtn.addEventListener("click", () => {
      // 要件どおり現時点では未実装（見た目のみ表示）
    });
  }
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      if (window.history.length > 1) {
        window.history.back();
        return;
      }
      window.location.assign("/map/index.html");
    });
  }
}

function loadRoadInfoDetail() {
  const params = new URLSearchParams(window.location.search);
  const pointId = Number(params.get("pointId"));
  if (!Number.isInteger(pointId) || pointId <= 0) {
    setError("道情報IDが不正です。");
    return;
  }

  fetch(`/api/road-info?pointId=${pointId}`)
    .then((res) => {
      if (res.status === 404) {
        throw new Error("not_found");
      }
      if (!res.ok) {
        throw new Error(`request_failed:${res.status}`);
      }
      return res.json();
    })
    .then((data) => {
      if (!data || !data.point) {
        throw new Error("invalid_payload");
      }
      renderTags(data.point.tags);
      renderPosts(data.point.posts);
      showContent();
    })
    .catch((err) => {
      if (err.message === "not_found") {
        setError("対象の道情報が見つかりませんでした。");
        return;
      }
      setError("道情報の読み込みに失敗しました。");
    });
}

initActions();
loadRoadInfoDetail();
