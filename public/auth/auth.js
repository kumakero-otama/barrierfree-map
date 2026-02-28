const loginForm = document.getElementById("login-form");
if (loginForm) {
  loginForm.addEventListener("submit", (event) => {
    event.preventDefault();
  });
}

const signupForm = document.getElementById("signup-form");
if (signupForm) {
  signupForm.addEventListener("submit", (event) => {
    event.preventDefault();
  });
}

const signupIconInput = document.getElementById("signup-icon");
const signupIconPreview = document.getElementById("signup-icon-preview");
let previewUrl = "";

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
