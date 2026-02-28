const loginForm = document.getElementById("login-form");
const signupForm = document.getElementById("signup-form");
const signupIconInput = document.getElementById("signup-icon");
const signupIconPreview = document.getElementById("signup-icon-preview");
const signupEmailRow = document.getElementById("signup-email-row");
const signupPasswordRow = document.getElementById("signup-password-row");
const signupEmailInput = document.getElementById("signup-email");
const signupPasswordInput = document.getElementById("signup-password");
let previewUrl = "";
let pendingGoogleIdToken = "";

if (signupIconInput && signupIconPreview) {
  signupIconInput.addEventListener("change", () => {
    const file = signupIconInput.files && signupIconInput.files[0];

    if (!file || !file.type.startsWith("image/")) {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        previewUrl = "";
      }
      signupIconPreview.removeAttribute("src");
      signupIconPreview.classList.add("hidden");
      return;
    }

    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }

    previewUrl = URL.createObjectURL(file);
    signupIconPreview.src = previewUrl;
    signupIconPreview.classList.remove("hidden");
  });
}

const GOOGLE_CLIENT_ID = "808129330394-dagp56961vbank89vi7bc50pp4u7mgv8.apps.googleusercontent.com";
const googleStatusElement = document.getElementById("google-auth-status");

function setGoogleStatus(message) {
  if (!googleStatusElement) {
    return;
  }
  googleStatusElement.textContent = message;
}

function setSignupGoogleMode(enabled) {
  if (!signupForm) {
    return;
  }
  if (signupEmailRow) {
    signupEmailRow.classList.toggle("hidden", enabled);
  }
  if (signupPasswordRow) {
    signupPasswordRow.classList.toggle("hidden", enabled);
  }
  if (signupEmailInput) {
    signupEmailInput.disabled = enabled;
  }
  if (signupPasswordInput) {
    signupPasswordInput.disabled = enabled;
  }
}

async function handleGoogleCredential(response) {
  const idToken = response && response.credential;
  if (!idToken) {
    setGoogleStatus("Google認証トークンの取得に失敗しました。");
    return;
  }

  if (signupForm) {
    pendingGoogleIdToken = idToken;
    setSignupGoogleMode(true);
    setGoogleStatus("Google認証が完了しました。ユーザー名を入力してサインアップしてください。");
    return;
  }

  setGoogleStatus("Google認証を確認中です...");
  await loginWithGoogle(idToken);
}

async function loginWithGoogle(idToken) {
  try {
    const res = await fetch("/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id_token: idToken }),
    });

    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      const errorMessage = payload.error || "google_auth_failed";
      if (errorMessage === "account_not_found") {
        setGoogleStatus("このGoogleアカウントは未登録です。サインアップ画面で登録してください。");
        return false;
      }
      if (errorMessage === "invalid_token") {
        setGoogleStatus(
          "Googleトークン検証に失敗しました。Google CloudのClient IDとAuthorized JavaScript originsを確認してください。"
        );
        return false;
      }
      if (errorMessage === "login_failed") {
        setGoogleStatus("ログイン処理に失敗しました。サーバーログを確認してください。");
        return false;
      }
      setGoogleStatus(`Googleログインに失敗しました: ${errorMessage}`);
      return false;
    }

    setGoogleStatus("ログイン成功。地図画面へ移動します...");
    window.location.href = "/map/Index.html";
    return true;
  } catch {
    setGoogleStatus("ネットワークエラーでGoogleログインに失敗しました。");
    return false;
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("file_read_failed"));
    reader.readAsDataURL(file);
  });
}

async function signupWithGoogle({ idToken, username, iconFile }) {
  let iconDataUrl = "";
  if (iconFile) {
    iconDataUrl = await fileToDataUrl(iconFile);
  }

  const res = await fetch("/auth/google/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id_token: idToken,
      username,
      icon_data_url: iconDataUrl,
    }),
  });

  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    const errorMessage = payload.error || "google_signup_failed";
    throw new Error(errorMessage);
  }

  window.location.href = "/map/Index.html";
}

function initGoogleSignIn() {
  const buttonContainer = document.getElementById("google-signin-button");
  if (!buttonContainer) {
    return;
  }

  const initialize = () => {
    if (!(window.google && window.google.accounts && window.google.accounts.id)) {
      setGoogleStatus("Googleログインの読み込みに失敗しました。");
      return;
    }
    window.google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: handleGoogleCredential,
    });
    window.google.accounts.id.renderButton(buttonContainer, {
      theme: "outline",
      size: "large",
      shape: "pill",
      text: signupForm ? "signup_with" : "signin_with",
      width: 320,
    });
  };

  if (document.readyState === "complete") {
    initialize();
    return;
  }
  window.addEventListener("load", initialize, { once: true });
}

initGoogleSignIn();

if (loginForm) {
  loginForm.addEventListener("submit", (event) => {
    event.preventDefault();
    setGoogleStatus("メール/パスワードログインは未実装です。Googleログインを使ってください。");
  });
}

if (signupForm) {
  signupForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!pendingGoogleIdToken) {
      setGoogleStatus("先に Googleでサインアップ を実行してください。");
      return;
    }

    const usernameInput = document.getElementById("signup-username");
    const username = usernameInput && typeof usernameInput.value === "string"
      ? usernameInput.value.trim()
      : "";
    if (!username) {
      setGoogleStatus("ユーザー名を入力してください。");
      return;
    }

    const iconFile = signupIconInput && signupIconInput.files
      ? signupIconInput.files[0]
      : null;
    if (!iconFile) {
      setGoogleStatus("アイコン画像を選択してください。");
      return;
    }

    try {
      setGoogleStatus("サインアップ中です...");
      await signupWithGoogle({ idToken: pendingGoogleIdToken, username, iconFile });
    } catch (err) {
      if (err.message === "not_found") {
        setGoogleStatus("サインアップAPIが見つかりません。サーバーを再起動してください。");
        return;
      }
      if (err.message === "invalid_token") {
        setGoogleStatus(
          "Googleトークン検証に失敗しました。Google CloudのClient IDとAuthorized JavaScript originsを確認してください。"
        );
        return;
      }
      if (err.message === "signup_failed") {
        setGoogleStatus("サインアップ処理に失敗しました。サーバーログを確認してください。");
        return;
      }
      setGoogleStatus(`Googleサインアップに失敗しました: ${err.message}`);
    }
  });
}
