const profileAvatarEl = document.getElementById("profile-avatar");
const profileUsernameEl = document.getElementById("profile-username");
const totalTactileEl = document.getElementById("total-tactile-length");
const totalRoadPostsEl = document.getElementById("total-road-posts");
const totalHeartsEl = document.getElementById("total-hearts");

function formatKm(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) {
    return "0";
  }
  return num.toFixed(1);
}

async function loadProfile() {
  try {
    const res = await fetch("/auth/me", { credentials: "same-origin" });
    if (!res.ok) {
      window.location.replace("/auth/login.html");
      return;
    }
    const payload = await res.json();
    const user = payload && payload.user ? payload.user : null;
    if (!user) {
      window.location.replace("/auth/login.html");
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
      totalTactileEl.textContent = `${formatKm(totalTactile)}km`;
    }
    if (totalRoadPostsEl) {
      totalRoadPostsEl.textContent = `${Number(totalRoadPosts || 0)}件`;
    }
    if (totalHeartsEl) {
      totalHeartsEl.textContent = `${Number(totalHearts || 0)}個`;
    }
  } catch {
    window.location.replace("/auth/login.html");
  }
}

loadProfile();
