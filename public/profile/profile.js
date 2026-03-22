const profileAvatarEl = document.getElementById("profile-avatar");
const profileUsernameEl = document.getElementById("profile-username");
const totalTactileEl = document.getElementById("total-tactile-length");
const totalRoadPostsEl = document.getElementById("total-road-posts");
const totalHeartsEl = document.getElementById("total-hearts");
const profileProBadgeEl = document.getElementById("profile-pro-badge");
const profileProToggleEl = document.getElementById("profile-pro-toggle");
const logoutBtnEl = document.getElementById("profile-logout-btn");
const editBtnEl = document.getElementById("profile-edit-btn");
const PROFILE_CACHE_KEY = "cached_profile_user.v1";
const authTokenApi = window.AuthToken || null;
let currentProfileUser = null;

function authFetch(input, init) {
  if (authTokenApi && typeof authTokenApi.authFetch === "function") {
    return authTokenApi.authFetch(input, init);
  }
  return fetch(input, init);
}

function clearAccessToken() {
  if (authTokenApi && typeof authTokenApi.clearAccessToken === "function") {
    authTokenApi.clearAccessToken();
  }
}

function formatMetersFromKm(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) {
    return "0";
  }
  return Math.round(num * 1000).toLocaleString("ja-JP");
}

function saveCachedProfileUser(user) {
  if (!user || typeof user !== "object") {
    return;
  }
  const base = currentProfileUser && typeof currentProfileUser === "object"
    ? currentProfileUser
    : loadCachedProfileUser() || {};
  const normalized = {
    userId: Number(user.userId || user.user_id || base.userId || 0) || null,
    username: user.username == null ? (base.username || null) : String(user.username),
    iconUrl: user.iconUrl || user.icon_url || base.iconUrl || null,
    totalTactileLength: Number(user.totalTactileLength || user.total_tactile_length || base.totalTactileLength || 0) || 0,
    totalRoadPosts: Number(user.totalRoadPosts || user.total_road_posts || base.totalRoadPosts || 0) || 0,
    totalHearts: Number(user.totalHearts || user.total_hearts || base.totalHearts || 0) || 0,
    isPro: user.isPro == null && user.is_pro == null ? Boolean(base.isPro) : Boolean(user.isPro || user.is_pro),
  };
  currentProfileUser = normalized;
  try {
    window.sessionStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(normalized));
  } catch {
    // ignore storage errors
  }
}

function loadCachedProfileUser() {
  try {
    const raw = window.sessionStorage.getItem(PROFILE_CACHE_KEY);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function applyProfileUser(user) {
  if (!user) {
    return;
  }
  saveCachedProfileUser(user);
  const profileUser = currentProfileUser || loadCachedProfileUser() || {};
  const username = profileUser.username || "username";
  const iconUrl = profileUser.iconUrl == null ? "/assets/account_default.png" : profileUser.iconUrl;
  const totalTactile = profileUser.totalTactileLength || 0;
  const totalRoadPosts = profileUser.totalRoadPosts || 0;
  const totalHearts = profileUser.totalHearts || 0;
  const isPro = Boolean(profileUser.isPro);

  if (profileAvatarEl) {
    profileAvatarEl.src = iconUrl;
    profileAvatarEl.alt = `${username}のアイコン`;
  }
  if (profileUsernameEl) {
    profileUsernameEl.textContent = username;
  }
  if (profileProBadgeEl) {
    profileProBadgeEl.hidden = !isPro;
  }
  if (profileProToggleEl) {
    profileProToggleEl.checked = isPro;
  }
  if (totalTactileEl) {
    totalTactileEl.textContent = `${formatMetersFromKm(totalTactile)}m`;
  }
  if (totalRoadPostsEl) {
    totalRoadPostsEl.textContent = `${Number(totalRoadPosts || 0)}件`;
  }
  if (totalHeartsEl) {
    totalHeartsEl.textContent = `${Number(totalHearts || 0)}個`;
  }
}

async function loadProStatus() {
  try {
    const res = await authFetch("/api/pro-status", {
      cache: "no-store",
    });
    if (!res.ok) {
      return;
    }
    const payload = await res.json();
    applyProfileUser({
      isPro: Boolean(payload && payload.isPro),
    });
  } catch {
    // ignore badge-only fetch failures
  }
}

async function updateProStatus(nextIsPro) {
  if (!profileProToggleEl) {
    return;
  }
  profileProToggleEl.disabled = true;
  try {
    const res = await authFetch("/api/pro-status", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        isPro: nextIsPro,
      }),
    });
    if (!res.ok) {
      throw new Error("pro_status_update_failed");
    }
    const payload = await res.json();
    applyProfileUser({
      isPro: Boolean(payload && payload.isPro),
    });
  } catch {
    profileProToggleEl.checked = !nextIsPro;
    window.alert("PROアカウントの更新に失敗しました。");
  } finally {
    profileProToggleEl.disabled = false;
  }
}

async function loadProfile() {
  const cached = loadCachedProfileUser();
  if (cached) {
    currentProfileUser = cached;
    applyProfileUser(cached);
  }
  try {
    const res = await authFetch("/auth/me", {
      cache: "no-store",
    });
    if (!res.ok) {
      clearAccessToken();
      window.location.replace("/auth/login.html");
      return;
    }
    const payload = await res.json();
    const user = payload && payload.user ? payload.user : null;
    if (!user) {
      clearAccessToken();
      window.location.replace("/auth/login.html");
      return;
    }
    applyProfileUser(user);
  } catch {
    clearAccessToken();
    window.location.replace("/auth/login.html");
  }
}

async function logout() {
  try {
    const res = await authFetch("/auth/logout", {
      method: "POST",
    });
    if (!res.ok) {
      throw new Error("logout_failed");
    }
  } catch {
    // Always redirect so the user can recover by logging in again.
  }
  clearAccessToken();
  window.location.replace("/auth/login.html");
}

if (logoutBtnEl) {
  logoutBtnEl.addEventListener("click", () => {
    const ok = window.confirm("ログアウトしてもよろしいですか？");
    if (!ok) {
      return;
    }
    logout();
  });
}

if (editBtnEl) {
  editBtnEl.addEventListener("click", () => {
    window.location.href = "/profile/edit.html";
  });
}

loadProfile();
loadProStatus();

if (profileProToggleEl) {
  profileProToggleEl.addEventListener("change", () => {
    updateProStatus(profileProToggleEl.checked);
  });
}
