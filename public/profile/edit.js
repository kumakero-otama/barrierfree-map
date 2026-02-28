const usernameInputEl = document.getElementById("profile-username-input");
const iconPreviewEl = document.getElementById("profile-icon-preview");
const cameraInputEl = document.getElementById("profile-icon-camera-input");
const uploadInputEl = document.getElementById("profile-icon-upload-input");
const backBtnEl = document.getElementById("profile-edit-back-btn");
const saveBtnEl = document.getElementById("profile-edit-save-btn");
const saveToastEl = document.getElementById("profile-save-toast");

let selectedIconDataUrl = null;
let saving = false;

function showSaveToast() {
  if (!saveToastEl) {
    return;
  }
  saveToastEl.classList.add("show");
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("file_read_error"));
    reader.readAsDataURL(file);
  });
}

async function applySelectedIcon(file) {
  if (!file) {
    return;
  }
  const dataUrl = await readFileAsDataUrl(file);
  selectedIconDataUrl = dataUrl;
  if (iconPreviewEl) {
    iconPreviewEl.src = dataUrl;
  }
}

async function loadCurrentProfile() {
  try {
    const res = await fetch("/auth/me", {
      credentials: "same-origin",
      cache: "no-store",
    });
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
    const username = user.username || "";
    const iconUrl = user.iconUrl == null ? "/assets/account_default.png" : user.iconUrl;

    if (usernameInputEl) {
      usernameInputEl.value = username;
    }
    if (iconPreviewEl) {
      iconPreviewEl.src = iconUrl;
      iconPreviewEl.alt = `${username || "ユーザー"}のアイコン`;
    }
  } catch {
    window.location.replace("/auth/login.html");
  }
}

async function saveProfile() {
  if (saving) {
    return;
  }
  const username = (usernameInputEl && usernameInputEl.value ? usernameInputEl.value : "").trim();
  if (!username) {
    window.alert("ユーザー名を入力してください。");
    return;
  }

  const body = { username };
  if (selectedIconDataUrl) {
    body.icon_data_url = selectedIconDataUrl;
  }

  try {
    saving = true;
    if (saveBtnEl) {
      saveBtnEl.disabled = true;
    }
    const res = await fetch("/auth/profile", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let reason = `status_${res.status}`;
      try {
        const payload = await res.json();
        if (payload && payload.error) {
          reason = payload.error;
        }
      } catch {
        // ignore json parse error
      }
      throw new Error(reason);
    }
    showSaveToast();
    window.setTimeout(() => {
      window.location.replace("/profile/Index.html");
    }, 2000);
  } catch (err) {
    saving = false;
    if (saveBtnEl) {
      saveBtnEl.disabled = false;
    }
    window.alert(`プロフィールの保存に失敗しました: ${err.message}`);
  }
}

if (cameraInputEl) {
  cameraInputEl.addEventListener("change", () => applySelectedIcon(cameraInputEl.files && cameraInputEl.files[0]));
}

if (uploadInputEl) {
  uploadInputEl.addEventListener("change", () => applySelectedIcon(uploadInputEl.files && uploadInputEl.files[0]));
}

if (backBtnEl) {
  backBtnEl.addEventListener("click", () => {
    window.location.replace("/profile/Index.html");
  });
}

if (saveBtnEl) {
  saveBtnEl.addEventListener("click", saveProfile);
}

loadCurrentProfile();
