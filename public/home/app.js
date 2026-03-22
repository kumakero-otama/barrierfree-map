const clockEl = document.getElementById("clock");
const homeProBadgeEl = document.getElementById("home-pro-badge");
const authTokenApi = window.AuthToken || null;

function authFetch(input, init) {
  if (authTokenApi && typeof authTokenApi.authFetch === "function") {
    return authTokenApi.authFetch(input, init);
  }
  return fetch(input, init);
}

// ホーム画面の時刻表示を現在時刻で更新する。
function updateClock() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  clockEl.textContent = `${hh}:${mm}:${ss}`;
}

updateClock();
setInterval(updateClock, 1000);

async function loadProStatus() {
  if (!homeProBadgeEl) {
    return;
  }
  try {
    const res = await authFetch("/api/pro-status", {
      cache: "no-store",
    });
    if (!res.ok) {
      return;
    }
    const payload = await res.json();
    homeProBadgeEl.hidden = !Boolean(payload && payload.isPro);
  } catch {
    homeProBadgeEl.hidden = true;
  }
}

loadProStatus();
