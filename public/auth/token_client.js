(function initAuthTokenClient(globalScope) {
  const ACCESS_TOKEN_KEY = "access_token.v1";

  function setAccessToken(token) {
    if (!token || typeof token !== "string") {
      return;
    }
    try {
      window.localStorage.setItem(ACCESS_TOKEN_KEY, token);
    } catch {
      // ignore storage errors
    }
  }

  function getAccessToken() {
    try {
      const token = window.localStorage.getItem(ACCESS_TOKEN_KEY);
      return token && String(token).trim() ? token : "";
    } catch {
      return "";
    }
  }

  function clearAccessToken() {
    try {
      window.localStorage.removeItem(ACCESS_TOKEN_KEY);
    } catch {
      // ignore storage errors
    }
  }

  function buildAuthHeaders(initialHeaders) {
    const headers = new Headers(initialHeaders || {});
    const token = getAccessToken();
    if (token && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    return headers;
  }

  function authFetch(input, init) {
    const options = { ...(init || {}) };
    options.headers = buildAuthHeaders(options.headers);
    return fetch(input, options);
  }

  globalScope.AuthToken = {
    setAccessToken,
    getAccessToken,
    clearAccessToken,
    buildAuthHeaders,
    authFetch,
  };
})(window);

