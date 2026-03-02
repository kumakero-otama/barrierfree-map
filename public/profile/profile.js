const profileAvatarEl = document.getElementById("profile-avatar");
const profileUsernameEl = document.getElementById("profile-username");
const totalTactileEl = document.getElementById("total-tactile-length");
const totalRoadPostsEl = document.getElementById("total-road-posts");
const totalHeartsEl = document.getElementById("total-hearts");
const logoutBtnEl = document.getElementById("profile-logout-btn");
const editBtnEl = document.getElementById("profile-edit-btn");
const PROFILE_CACHE_KEY = "cached_profile_user.v1";
const authTokenApi = window.AuthToken || null;

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
  const normalized = {
    userId: Number(user.userId || user.user_id || 0) || null,
    username: user.username == null ? null : String(user.username),
    iconUrl: user.iconUrl || user.icon_url || null,
    totalTactileLength: Number(user.totalTactileLength || user.total_tactile_length || 0) || 0,
    totalRoadPosts: Number(user.totalRoadPosts || user.total_road_posts || 0) || 0,
    totalHearts: Number(user.totalHearts || user.total_hearts || 0) || 0,
  };
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
  const username = user.username || "username";
  const iconUrl = user.iconUrl == null ? "/assets/account_default.png" : user.iconUrl;
  const totalTactile = user.totalTactileLength || 0;
  const totalRoadPosts = user.totalRoadPosts || 0;
  const totalHearts = user.totalHearts || 0;

  if (profileAvatarEl) {
    profileAvatarEl.src = iconUrl;
    profileAvatarEl.alt = `${username}のアイコン`;
  }
  if (profileUsernameEl) {
    profileUsernameEl.textContent = username;
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

async function loadProfile() {
  const cached = loadCachedProfileUser();
  if (cached) {
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
    saveCachedProfileUser(user);
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
