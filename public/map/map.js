const map = L.map("map", { zoomControl: true }).setView([35.681236, 139.767125], 13);
const mapLayoutEl = document.getElementById("map-layout");
const coordsEl = document.getElementById("coords");
const rawCoordsEl = document.getElementById("raw-coords");
const lastUpdatedEl = document.getElementById("last-updated");
const mapControlsPanelEl = document.getElementById("map-controls-panel");
const mapControlsHandleEl = document.getElementById("map-controls-handle");
const toggleRecordBtn = document.getElementById("toggle-record");
const toggleShowMapInfoBtn = document.getElementById("toggle-show-map-info");
const toggleCenterCurrentBtn = document.getElementById("toggle-center-current");
const osmLoadingOverlayEl = document.getElementById("osm-loading-overlay");
const recordsLoadingOverlayEl = document.getElementById("records-loading-overlay");
const traceConfirmModalEl = document.getElementById("trace-confirm-modal");
const traceConfirmMapEl = document.getElementById("trace-confirm-map");
const traceConfirmMessageEl = document.getElementById("trace-confirm-message");
const traceConfirmOkBtn = document.getElementById("trace-confirm-ok");
const traceConfirmCancelBtn = document.getElementById("trace-confirm-cancel");
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

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

const redPinIcon = L.icon({
  iconUrl: "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41], // ピンの先端（下部中央）を座標に合わせる
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});
const bluePinIcon = L.icon({
  iconUrl: "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-blue.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

let MIN_REQUEST_INTERVAL_MS = 2000; // 2秒間隔
let latestLocation = null; // OSからの最新位置情報を保持する変数
let marker = null;
const trail = [];
const MAX_TRAIL = 100;
let lastDot = null;
let lastSent = null;
let lastRequestTime = 0;
let recordEnabled = false;
let recordedRawPoints = []; // レコード中のrawデータをメモリに保存
let tracePolyline = null; // trace_attributesの結果を表示する黄緑線
let currentSessionId = null;
let currentSessionStartedAt = null;
let traceConfirmMap = null;
let traceConfirmPathLayer = null;
let isHandlingRecordToggle = false;
let currentUserId = null;
let latestSnappedLocation = null;
let mapLayoutSyncTimer = null;

// Valhallaの6桁精度ポリラインをデコードする関数
function decodePolyline(str, precision) {
  let index = 0,
    lat = 0,
    lng = 0,
    coordinates = [],
    shift = 0,
    result = 0,
    byte = null,
    latitude_change,
    longitude_change,
    factor = Math.pow(10, precision || 6);

  while (index < str.length) {
    byte = null;
    shift = 0;
    result = 0;

    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    latitude_change = ((result & 1) ? ~(result >> 1) : (result >> 1));

    shift = 0;
    result = 0;

    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    longitude_change = ((result & 1) ? ~(result >> 1) : (result >> 1));

    lat += latitude_change;
    lng += longitude_change;

    coordinates.push([lat / factor, lng / factor]);
  }

  return coordinates;
}

let allRecordsMarkers = [];
let osmTactileMarkers = [];
let roadInfoMarkers = [];
let isZooming = false;
let suppressMapTapUntil = 0;
let osmTactileLoadRequestSeq = 0;
let recordsLoadRequestSeq = 0;
let roadInfoLoadRequestSeq = 0;
const MAP_TAP_SUPPRESS_AFTER_ZOOM_MS = 400;
const MAP_DISPLAY_SETTINGS_KEY = "mapDisplaySettings.v1";
const MAP_CONTROLS_COLLAPSED_KEY = "mapControlsCollapsed.v1";
const DEFAULT_MAP_DISPLAY_SETTINGS = {
  showAppTactile: true,
  showOsmTactile: true,
  showAllRoadInfo: true,
  showOnlyMyTactile: false,
  showOnlyMyRoadInfo: false,
};

function loadMapDisplaySettings() {
  try {
    const raw = localStorage.getItem(MAP_DISPLAY_SETTINGS_KEY);
    if (!raw) {
      return { ...DEFAULT_MAP_DISPLAY_SETTINGS };
    }
    const parsed = JSON.parse(raw);
    return {
      showAppTactile: Boolean(parsed && parsed.showAppTactile),
      showOsmTactile: Boolean(parsed && parsed.showOsmTactile),
      showAllRoadInfo: Boolean(parsed && parsed.showAllRoadInfo),
      showOnlyMyTactile: Boolean(parsed && parsed.showOnlyMyTactile),
      showOnlyMyRoadInfo: Boolean(parsed && parsed.showOnlyMyRoadInfo),
    };
  } catch (err) {
    console.warn("[Settings] Failed to parse map display settings. Use defaults.", err);
    return { ...DEFAULT_MAP_DISPLAY_SETTINGS };
  }
}

const mapDisplaySettings = loadMapDisplaySettings();

function refreshMapDisplaySettings() {
  const latest = loadMapDisplaySettings();
  mapDisplaySettings.showAppTactile = Boolean(latest.showAppTactile);
  mapDisplaySettings.showOsmTactile = Boolean(latest.showOsmTactile);
  mapDisplaySettings.showAllRoadInfo = Boolean(latest.showAllRoadInfo);
  mapDisplaySettings.showOnlyMyTactile = Boolean(latest.showOnlyMyTactile);
  mapDisplaySettings.showOnlyMyRoadInfo = Boolean(latest.showOnlyMyRoadInfo);
}

function loadMapControlsCollapsed() {
  try {
    return localStorage.getItem(MAP_CONTROLS_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function saveMapControlsCollapsed(collapsed) {
  try {
    localStorage.setItem(MAP_CONTROLS_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // ignore storage failure
  }
}

function setMapControlsCollapsed(collapsed) {
  if (!mapLayoutEl || !mapControlsPanelEl || !mapControlsHandleEl) {
    return;
  }
  mapControlsPanelEl.classList.toggle("collapsed", collapsed);
  mapLayoutEl.classList.toggle("panel-collapsed", collapsed);
  mapControlsHandleEl.setAttribute("aria-expanded", collapsed ? "false" : "true");
  saveMapControlsCollapsed(collapsed);
  // 1) 即時反映 2) アニメーション終了後反映 の2段でズレを防ぐ。
  requestAnimationFrame(() => {
    map.invalidateSize();
    recenterToLatestLocation();
  });
  if (mapLayoutSyncTimer) {
    clearTimeout(mapLayoutSyncTimer);
  }
  mapLayoutSyncTimer = setTimeout(() => {
    map.invalidateSize();
    recenterToLatestLocation();
  }, 280);
}

function initMapControlsPanelGesture() {
  if (!mapControlsPanelEl || !mapControlsHandleEl) {
    return;
  }

  mapControlsHandleEl.addEventListener("click", () => {
    const collapsed = mapControlsPanelEl.classList.contains("collapsed");
    setMapControlsCollapsed(!collapsed);
  });

  mapControlsPanelEl.addEventListener("transitionend", (event) => {
    if (event.propertyName !== "grid-template-rows") {
      return;
    }
    map.invalidateSize();
    recenterToLatestLocation();
  });

  setMapControlsCollapsed(loadMapControlsCollapsed());
}

function isMapInfoEnabled() {
  return Boolean(toggleShowMapInfoBtn && toggleShowMapInfoBtn.checked);
}

function shouldShowAppTactile() {
  return isMapInfoEnabled() && (mapDisplaySettings.showAppTactile || mapDisplaySettings.showOnlyMyTactile);
}

function shouldShowOsmTactile() {
  return isMapInfoEnabled() && mapDisplaySettings.showOsmTactile;
}

function shouldShowRoadInfo() {
  return isMapInfoEnabled() && (mapDisplaySettings.showAllRoadInfo || mapDisplaySettings.showOnlyMyRoadInfo);
}

function shouldShowOnlyMyTactile() {
  return Boolean(mapDisplaySettings.showOnlyMyTactile);
}

function shouldShowOnlyMyRoadInfo() {
  return Boolean(mapDisplaySettings.showOnlyMyRoadInfo);
}

function shouldIgnoreMapTap(event) {
  if (isZooming || Date.now() < suppressMapTapUntil) {
    return true;
  }

  const originalEvent = event?.originalEvent;
  if (!originalEvent) {
    return false;
  }

  // Double click zoom/wheel zoom should not trigger navigation.
  return originalEvent.type === "dblclick" || originalEvent.type === "wheel" || originalEvent.type === "mousewheel";
}

map.on("zoomstart", () => {
  isZooming = true;
  suppressMapTapUntil = Date.now() + MAP_TAP_SUPPRESS_AFTER_ZOOM_MS;
});

map.on("zoomend", () => {
  isZooming = false;
  suppressMapTapUntil = Date.now() + MAP_TAP_SUPPRESS_AFTER_ZOOM_MS;
});

map.on("click", (event) => {
  if (shouldIgnoreMapTap(event)) {
    return;
  }

  const lat = Number(event?.latlng?.lat);
  const lng = Number(event?.latlng?.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const params = new URLSearchParams({
      lat: lat.toString(),
      lng: lng.toString(),
    });
    window.location.assign(`/post_road/Index.html?${params.toString()}`);
    return;
  }
  window.location.assign("/post_road/Index.html");
});

initMapControlsPanelGesture();
window.addEventListener("pageshow", () => {
  refreshMapDisplaySettings();
  applyMapInfoVisibility();
});

// UUID v4 生成関数
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

async function loadCurrentUserId() {
  const res = await authFetch("/auth/me");
  if (!res.ok) {
    clearAccessToken();
    window.location.replace("/auth/login.html");
    throw new Error("unauthorized");
  }
  const payload = await res.json();
  const userId = payload && payload.user ? Number(payload.user.userId) : NaN;
  if (!Number.isFinite(userId) || userId <= 0) {
    clearAccessToken();
    window.location.replace("/auth/login.html");
    throw new Error("invalid_user");
  }
  currentUserId = userId;
}

function updateRecordButton() {
  toggleRecordBtn.checked = recordEnabled;
}

function postSessionLifecycle(action, payload) {
  return authFetch(`/api/session/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
    .then((res) => {
      if (!res.ok) {
        throw new Error(`session ${action} failed: ${res.status}`);
      }
      return res.json();
    })
    .catch((err) => {
      console.error(`[Session] ${action} error:`, err);
    });
}

function extractTraceCoordinates(data, rawShape) {
  if (data && Array.isArray(data.edges) && data.edges.length > 0) {
    let allCoords = [];
    data.edges.forEach((edge) => {
      if (!edge || !edge.shape) {
        return;
      }
      const edgeCoords = decodePolyline(edge.shape, 6);
      if (allCoords.length > 0 && edgeCoords.length > 0) {
        const lastPoint = allCoords[allCoords.length - 1];
        const firstPoint = edgeCoords[0];
        if (lastPoint[0] === firstPoint[0] && lastPoint[1] === firstPoint[1]) {
          allCoords = allCoords.concat(edgeCoords.slice(1));
          return;
        }
      }
      allCoords = allCoords.concat(edgeCoords);
    });
    if (allCoords.length > 1) {
      return allCoords;
    }
  }

  if (data && data.shape) {
    const decoded = decodePolyline(data.shape, 6);
    if (decoded.length > 1) {
      return decoded;
    }
  }

  if (data && Array.isArray(data.matched_points) && data.matched_points.length > 1) {
    return data.matched_points
      .map((p) => [Number(p.lat), Number(p.lon)])
      .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
  }

  return rawShape
    .map((p) => [p.lat, p.lon])
    .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
}

function requestTraceData(shape, { sessionId = null, persist = false } = {}) {
  const requestBody = {
    shape,
    costing: "pedestrian",
    shape_match: "map_snap",
  };
  if (persist && sessionId) {
    requestBody.sessionId = sessionId;
    requestBody.source = "valhalla";
  }

  return authFetch("/api/trace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  }).then((res) => {
    if (!res.ok) {
      throw new Error(`trace failed: ${res.status}`);
    }
    return res.json();
  });
}

// trace_attributesでフィッティングしてマップに表示
function processAndDisplayTrace(sessionId = null) {
  if (recordedRawPoints.length < 2) {
    console.log("[processAndDisplayTrace] Not enough points:", recordedRawPoints.length);
    alert("記録されたポイントが少なすぎます（最低2点必要）");
    return Promise.resolve(null);
  }

  const shape = recordedRawPoints.map((p) => ({ lat: p.lat, lon: p.lng }));
  return requestTraceData(shape, { sessionId, persist: Boolean(sessionId) })
    .then((data) => {
      const coords = extractTraceCoordinates(data, shape);
      displayTraceLine(coords);
      return { data, coords };
    })
    .catch((err) => {
      console.error("[processAndDisplayTrace] Error:", err);
      alert(`トレース処理に失敗しました: ${err.message}`);
      return null;
    });
}

// 黄緑の線を表示
function displayTraceLine(coordinates) {
  // 前回の線を削除
  if (tracePolyline) {
    map.removeLayer(tracePolyline);
    tracePolyline = null;
  }
  
  if (coordinates.length > 1) {
    tracePolyline = L.polyline(coordinates, {
      color: "#9acd32",  // 黄緑色
      weight: 4,
      opacity: 0.8,
    }).addTo(map);
    console.log(`[displayTraceLine] Displayed trace with ${coordinates.length} points`);
  }
}

function closeTraceConfirmModal() {
  if (traceConfirmModalEl) {
    traceConfirmModalEl.classList.add("hidden");
  }
  if (traceConfirmPathLayer && traceConfirmMap) {
    traceConfirmMap.removeLayer(traceConfirmPathLayer);
    traceConfirmPathLayer = null;
  }
  if (traceConfirmMap) {
    traceConfirmMap.remove();
    traceConfirmMap = null;
  }
}

function openTraceConfirmModal(coordinates) {
  return new Promise((resolve) => {
    if (!traceConfirmModalEl || !traceConfirmMapEl || !traceConfirmOkBtn || !traceConfirmCancelBtn) {
      resolve("cancel");
      return;
    }

    traceConfirmModalEl.classList.remove("hidden");
    traceConfirmMap = L.map(traceConfirmMapEl, { zoomControl: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(traceConfirmMap);

    traceConfirmPathLayer = L.polyline(coordinates, {
      color: "#9acd32",
      weight: 5,
      opacity: 0.9,
    }).addTo(traceConfirmMap);
    traceConfirmMap.fitBounds(traceConfirmPathLayer.getBounds(), { padding: [20, 20] });

    const cleanupAndResolve = (result) => {
      traceConfirmOkBtn.removeEventListener("click", onOk);
      traceConfirmCancelBtn.removeEventListener("click", onCancel);
      closeTraceConfirmModal();
      resolve(result);
    };

    const onOk = () => cleanupAndResolve("ok");
    const onCancel = () => cleanupAndResolve("cancel");

    traceConfirmOkBtn.addEventListener("click", onOk);
    traceConfirmCancelBtn.addEventListener("click", onCancel);

    setTimeout(() => {
      if (traceConfirmMap) {
        traceConfirmMap.invalidateSize();
      }
    }, 0);
  });
}

async function handleRecordStopWithConfirmation(finishedSessionId) {
  if (!finishedSessionId) {
    return;
  }

  if (recordedRawPoints.length < 2) {
    alert("記録されたポイントが少なすぎます（最低2点必要）");
    await postSessionLifecycle("cancel", {
      sessionId: finishedSessionId,
    });
    return;
  }

  const shape = recordedRawPoints.map((p) => ({ lat: p.lat, lon: p.lng }));
  let previewData;
  try {
    previewData = await requestTraceData(shape);
  } catch (err) {
    console.error("[Record] preview trace error:", err);
    alert(`保存確認用の経路生成に失敗しました: ${err.message}`);
    await postSessionLifecycle("cancel", {
      sessionId: finishedSessionId,
    });
    return;
  }

  const previewCoords = extractTraceCoordinates(previewData, shape);
  if (!Array.isArray(previewCoords) || previewCoords.length < 2) {
    alert("保存確認用の経路を生成できませんでした。");
    await postSessionLifecycle("cancel", {
      sessionId: finishedSessionId,
    });
    return;
  }

  if (traceConfirmMessageEl) {
    traceConfirmMessageEl.textContent = "セッション全体でフィッティングした経路を黄緑線で表示しています。";
  }

  const decision = await openTraceConfirmModal(previewCoords);
  if (decision === "ok") {
    await postSessionLifecycle("end", {
      sessionId: finishedSessionId,
      endedAt: new Date().toISOString(),
    });
    await processAndDisplayTrace(finishedSessionId);
    return;
  }

  await postSessionLifecycle("cancel", {
    sessionId: finishedSessionId,
  });
  if (tracePolyline) {
    map.removeLayer(tracePolyline);
    tracePolyline = null;
  }
}

function requestSnappedLocation(latitude, longitude) {
  if (!currentUserId) {
    return;
  }
  const params = new URLSearchParams({
    lat: latitude.toString(),
    lng: longitude.toString(),
    userId: String(currentUserId),
  });
  if (recordEnabled) {
    params.set("record", "1");
    if (currentSessionId) {
      params.set("sessionId", currentSessionId);
    }
  }
  
  if (lastSent) {
    params.set("prevLat", lastSent.latitude.toString());
    params.set("prevLng", lastSent.longitude.toString());
  }

  console.log(`[requestSnappedLocation] Requesting: lat=${latitude}, lng=${longitude}`);

  authFetch(`/api/match?${params.toString()}`)
    .then((res) => {
      console.log(`[requestSnappedLocation] Response status: ${res.status}`);
      if (res.status === 204) {
        console.log('[requestSnappedLocation] Received 204 No Content - no update');
        // 変化がなくても現在値を表示更新（時刻などは変わる）
        updateDisplay(latitude, longitude, latitude, longitude, true);
        return null;
      }
      if (!res.ok) {
        throw new Error(`match failed with status ${res.status}`);
      }
      return res.json();
    })
    .then((data) => {
      console.log('[requestSnappedLocation] Response data:', data);
      if (!data) {
        console.log('[requestSnappedLocation] No data received (204 response)');
        return;
      }
      if (typeof data.lat === "number" && typeof data.lng === "number") {
        console.log(`[requestSnappedLocation] Valid snapped coordinates: lat=${data.lat}, lng=${data.lng}`);
        updateDisplay(latitude, longitude, data.lat, data.lng);
        // スナップされた座標を次回の基準点として保存
        lastSent = { latitude: data.lat, longitude: data.lng };
      } else {
        console.warn('[requestSnappedLocation] Invalid data format:', data);
        return;
      }
    })
    .catch((error) => {
      console.error('[requestSnappedLocation] Error:', error);
      // keep current display on failure
    });
}

function handleNewLocation(latitude, longitude) {
  // 位置情報を変数に保存するだけ（書き込み）
  latestLocation = { lat: latitude, lng: longitude };
}

function pollAndSendLocation() {
  if (!latestLocation) return;

  const { lat, lng } = latestLocation;

  // レコードON時はrawデータをメモリに保存
  if (recordEnabled) {
    recordedRawPoints.push({ lat, lng });
    console.log(`[Record] Saved raw point: ${recordedRawPoints.length} points`);
  }

  // サーバーへ送信（読み取り）
  requestSnappedLocation(lat, lng);
}

function updateTimestamp() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  lastUpdatedEl.textContent = `Last update: ${hh}:${mm}:${ss}`;
}

function isCenterCurrentEnabled() {
  // DOM上の現在値を都度参照して、内部状態とのズレを防ぐ
  return toggleCenterCurrentBtn ? toggleCenterCurrentBtn.checked : true;
}

function recenterToLatestLocation() {
  if (!isCenterCurrentEnabled()) {
    return;
  }
  const currentZoom = map.getZoom();
  if (latestSnappedLocation) {
    map.setView([latestSnappedLocation.lat, latestSnappedLocation.lng], currentZoom, { animate: false });
    return;
  }
  if (marker) {
    const pos = marker.getLatLng();
    if (pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lng)) {
      map.setView([pos.lat, pos.lng], currentZoom, { animate: false });
      return;
    }
  }
  if (latestLocation && Number.isFinite(latestLocation.lat) && Number.isFinite(latestLocation.lng)) {
    map.setView([latestLocation.lat, latestLocation.lng], currentZoom, { animate: false });
  }
}

function updateDisplay(rawLat, rawLng, snappedLat, snappedLng, skipMarker = false) {
  console.log(`[updateDisplay] Updating display: raw=(${rawLat}, ${rawLng}), snapped=(${snappedLat}, ${snappedLng})`);
  
  // 座標の妥当性チェック
  if (!Number.isFinite(snappedLat) || !Number.isFinite(snappedLng)) {
    console.error('[updateDisplay] Invalid snapped coordinates:', snappedLat, snappedLng);
    return;
  }
  
  // 地図の再描画に合わせて時刻を更新
  updateTimestamp();

  coordsEl.textContent = `Lat: ${snappedLat.toFixed(6)}, Lng: ${snappedLng.toFixed(6)}`;
  rawCoordsEl.textContent = `Raw: ${rawLat.toFixed(6)}, ${rawLng.toFixed(6)}`;
  latestSnappedLocation = { lat: snappedLat, lng: snappedLng };

  // 「現在地の中央表示」がONのときのみ地図の表示位置を更新
  if (isCenterCurrentEnabled()) {
    const currentZoom = map.getZoom();
    console.log(`[updateDisplay] Moving map to (${snappedLat}, ${snappedLng}) with zoom ${currentZoom}`);
    map.setView([snappedLat, snappedLng], currentZoom, { animate: false });
  }

  if (skipMarker) return;
  
  // マーカーの更新
  if (!marker) {
    console.log('[updateDisplay] Creating new marker');
    marker = L.marker([snappedLat, snappedLng], { icon: redPinIcon }).addTo(map);
  } else {
    console.log('[updateDisplay] Updating existing marker position');
    marker.setLatLng([snappedLat, snappedLng]);
  }

  // ドット（点）だけを表示
  const dotColor = recordEnabled ? "#9acd32" : "#111";
  const dot = L.circleMarker([snappedLat, snappedLng], {
    radius: 3,
    color: dotColor,
    fillColor: dotColor,
    fillOpacity: 0.7,
    weight: 0,
  }).addTo(map);
  
  trail.push(dot);
  if (trail.length > MAX_TRAIL) {
    map.removeLayer(trail.shift());
  }
  
  console.log('[updateDisplay] Display update complete');
}

// session_pathsを取得して表示
function loadAndShowAllRecords() {
  refreshMapDisplaySettings();
  const requestSeq = ++recordsLoadRequestSeq;
  setRecordsLoadingVisible(true);
  console.log("[loadAndShowAllRecords] Fetching all session paths...");
  const center = map.getCenter();
  const params = new URLSearchParams({
    centerLat: center.lat.toString(),
    centerLng: center.lng.toString(),
    radiusKm: "10",
  });
  if (shouldShowOnlyMyTactile()) {
    params.set("mine", "1");
  }
  authFetch(`/api/records?${params.toString()}`)
    .then((res) => {
      if (!res.ok) {
        throw new Error(`records fetch failed: ${res.status}`);
      }
      return res.json();
    })
    .then((data) => {
      if (requestSeq !== recordsLoadRequestSeq || !shouldShowAppTactile()) {
        return;
      }
      console.log(`[loadAndShowAllRecords] Loaded ${data.count} paths`);
      if (data.success && Array.isArray(data.paths)) {
        showAllSessionPathsOnMap(data.paths);
      }
    })
    .catch((err) => {
      if (requestSeq !== recordsLoadRequestSeq) {
        return;
      }
      console.error("[loadAndShowAllRecords] Error:", err);
      alert("軌跡データの取得に失敗しました。");
    })
    .finally(() => {
      if (requestSeq === recordsLoadRequestSeq) {
        setRecordsLoadingVisible(false);
      }
    });
}

// session_pathsの全軌跡を地図上に表示
function showAllSessionPathsOnMap(paths) {
  clearAllRecordsFromMap();
  const visiblePaths = paths.filter((path) => {
    if (!shouldShowOnlyMyTactile()) {
      return true;
    }
    const ownerUserId = Number(path && path.user_id);
    return Number.isFinite(ownerUserId) && Number.isFinite(currentUserId) && ownerUserId === currentUserId;
  });

  console.log(`[showAllSessionPathsOnMap] Showing ${visiblePaths.length}/${paths.length} paths`);

  visiblePaths.forEach((path) => {
    let geom;
    try {
      geom = typeof path.geom_geojson === "string"
        ? JSON.parse(path.geom_geojson)
        : path.geom_geojson;
    } catch (err) {
      console.warn("[showAllSessionPathsOnMap] invalid geom_geojson:", err);
      return;
    }
    if (!geom || geom.type !== "LineString" || !Array.isArray(geom.coordinates)) {
      return;
    }

    const coordinates = geom.coordinates
      .map(([lng, lat]) => [lat, lng])
      .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
    if (coordinates.length < 2) {
      return;
    }

    const polyline = L.polyline(coordinates, {
      color: "#00b050",
      weight: 4,
      opacity: 0.85,
    }).addTo(map);
    allRecordsMarkers.push(polyline);
  });

  console.log(`[showAllSessionPathsOnMap] Displayed ${allRecordsMarkers.length} polylines`);
}

// 全レコードを地図から削除
function clearAllRecordsFromMap() {
  console.log(`[clearAllRecordsFromMap] Removing ${allRecordsMarkers.length} displayed paths`);
  allRecordsMarkers.forEach((marker) => {
    map.removeLayer(marker);
  });
  allRecordsMarkers = [];
}

// アプリ点字ブロック取得中に中央ローディングを表示する。
function setRecordsLoadingVisible(visible) {
  if (!recordsLoadingOverlayEl) {
    return;
  }
  if (visible) {
    recordsLoadingOverlayEl.classList.remove("hidden");
    return;
  }
  recordsLoadingOverlayEl.classList.add("hidden");
}

function loadAndShowOsmTactileWays() {
  // トグルONの最新リクエストだけを有効にするための採番。
  const requestSeq = ++osmTactileLoadRequestSeq;
  setOsmLoadingVisible(true);
  console.log("[loadAndShowOsmTactileWays] Fetching tactile ways from OSM...");
  const center = map.getCenter();
  const params = new URLSearchParams({
    centerLat: center.lat.toString(),
    centerLng: center.lng.toString(),
    radiusKm: "10",
  });
  authFetch(`/api/osm-tactile-ways?${params.toString()}`)
    .then((res) => {
      if (!res.ok) {
        throw new Error(`osm tactile fetch failed: ${res.status}`);
      }
      return res.json();
    })
    .then((data) => {
      if (requestSeq !== osmTactileLoadRequestSeq || !shouldShowOsmTactile()) {
        return;
      }
      if (!data || !Array.isArray(data.features)) {
        throw new Error("invalid osm tactile payload");
      }
      console.log(`[loadAndShowOsmTactileWays] Loaded ${data.features.length} ways`);
      showOsmTactileWaysOnMap(data.features);
    })
    .catch((err) => {
      if (requestSeq !== osmTactileLoadRequestSeq) {
        return;
      }
      console.error("[loadAndShowOsmTactileWays] Error:", err);
      alert("OSM点字ブロックデータの取得に失敗しました。");
      clearOsmTactileWaysFromMap();
    })
    .finally(() => {
      if (requestSeq === osmTactileLoadRequestSeq) {
        setOsmLoadingVisible(false);
      }
    });
}

function showOsmTactileWaysOnMap(features) {
  clearOsmTactileWaysFromMap();

  features.forEach((feature) => {
    if (!feature || !feature.geometry || typeof feature.geometry.type !== "string") {
      return;
    }
    if (feature.geometry.type === "LineString") {
      if (!Array.isArray(feature.geometry.coordinates)) {
        return;
      }
      const coordinates = feature.geometry.coordinates
        .map(([lng, lat]) => [lat, lng])
        .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));

      if (coordinates.length < 2) {
        return;
      }

      const polyline = L.polyline(coordinates, {
        color: "#0066ff",
        weight: 4,
        opacity: 0.9,
      }).addTo(map);
      osmTactileMarkers.push(polyline);
      return;
    }

    if (feature.geometry.type === "Point") {
      const [lng, lat] = Array.isArray(feature.geometry.coordinates)
        ? feature.geometry.coordinates
        : [NaN, NaN];
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return;
      }

      const point = L.circleMarker([lat, lng], {
        radius: 4,
        color: "#0066ff",
        fillColor: "#0066ff",
        fillOpacity: 0.95,
        weight: 1,
      }).addTo(map);
      osmTactileMarkers.push(point);
    }
  });

  console.log(`[showOsmTactileWaysOnMap] Displayed ${osmTactileMarkers.length} polylines`);
}

function clearOsmTactileWaysFromMap() {
  console.log(`[clearOsmTactileWaysFromMap] Removing ${osmTactileMarkers.length} displayed ways`);
  osmTactileMarkers.forEach((marker) => {
    map.removeLayer(marker);
  });
  osmTactileMarkers = [];
}

// OSM取得中にだけ中央ローディング表示を切り替える。
function setOsmLoadingVisible(visible) {
  if (!osmLoadingOverlayEl) {
    return;
  }
  if (visible) {
    osmLoadingOverlayEl.classList.remove("hidden");
    return;
  }
  osmLoadingOverlayEl.classList.add("hidden");
}

function loadAndShowRoadInfoPoints() {
  refreshMapDisplaySettings();
  const requestSeq = ++roadInfoLoadRequestSeq;
  // 地図中心から10kmの道情報ポイントを取得する。
  console.log("[loadAndShowRoadInfoPoints] Fetching road info points...");
  const center = map.getCenter();
  const params = new URLSearchParams({
    centerLat: center.lat.toString(),
    centerLng: center.lng.toString(),
    radiusKm: "10",
  });
  if (shouldShowOnlyMyRoadInfo()) {
    params.set("mine", "1");
  }
  authFetch(`/api/road-info?${params.toString()}`)
    .then((res) => {
      if (!res.ok) {
        throw new Error(`road-info fetch failed: ${res.status}`);
      }
      return res.json();
    })
    .then((data) => {
      if (requestSeq !== roadInfoLoadRequestSeq || !shouldShowRoadInfo()) {
        return;
      }
      if (!data || !Array.isArray(data.points)) {
        throw new Error("invalid road-info payload");
      }
      showRoadInfoPointsOnMap(data.points);
    })
    .catch((err) => {
      if (requestSeq !== roadInfoLoadRequestSeq) {
        return;
      }
      console.error("[loadAndShowRoadInfoPoints] Error:", err);
      alert("道情報データの取得に失敗しました。");
      clearRoadInfoPointsFromMap();
    });
}

function showRoadInfoPointsOnMap(points) {
  // 既存ピンを消してから最新結果だけを表示する。
  clearRoadInfoPointsFromMap();
  const visiblePoints = points.filter((point) => {
    if (!shouldShowOnlyMyRoadInfo()) {
      return true;
    }
    const createdBy = Number(point && point.createdBy);
    return Number.isFinite(createdBy) && Number.isFinite(currentUserId) && createdBy === currentUserId;
  });

  visiblePoints.forEach((point) => {
    const lat = Number(point && point.lat);
    const lng = Number(point && point.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return;
    }

    const pin = L.marker([lat, lng], {
      icon: bluePinIcon,
    }).addTo(map);
    pin.on("click", () => {
      const pointId = Number(point.id);
      if (!Number.isInteger(pointId) || pointId <= 0) {
        return;
      }
      window.location.assign(`/road_info_detail/Index.html?pointId=${pointId}`);
    });
    roadInfoMarkers.push(pin);
  });

  console.log(`[showRoadInfoPointsOnMap] Displayed ${roadInfoMarkers.length}/${points.length} points`);
}

function clearRoadInfoPointsFromMap() {
  // 道情報ピンレイヤーをすべて破棄する。
  console.log(`[clearRoadInfoPointsFromMap] Removing ${roadInfoMarkers.length} points`);
  roadInfoMarkers.forEach((marker) => {
    map.removeLayer(marker);
  });
  roadInfoMarkers = [];
}

function applyMapInfoVisibility() {
  refreshMapDisplaySettings();
  if (!isMapInfoEnabled()) {
    recordsLoadRequestSeq += 1;
    osmTactileLoadRequestSeq += 1;
    roadInfoLoadRequestSeq += 1;
    setRecordsLoadingVisible(false);
    setOsmLoadingVisible(false);
    clearAllRecordsFromMap();
    clearOsmTactileWaysFromMap();
    clearRoadInfoPointsFromMap();
    return;
  }

  if (shouldShowAppTactile()) {
    loadAndShowAllRecords();
  } else {
    recordsLoadRequestSeq += 1;
    setRecordsLoadingVisible(false);
    clearAllRecordsFromMap();
  }

  if (shouldShowOsmTactile()) {
    loadAndShowOsmTactileWays();
  } else {
    osmTactileLoadRequestSeq += 1;
    setOsmLoadingVisible(false);
    clearOsmTactileWaysFromMap();
  }

  if (shouldShowRoadInfo()) {
    loadAndShowRoadInfoPoints();
  } else {
    roadInfoLoadRequestSeq += 1;
    clearRoadInfoPointsFromMap();
  }
}

// サーバーから設定を取得
function loadConfig() {
  return authFetch("/api/config")
    .then((res) => {
      if (!res.ok) {
        throw new Error("config fetch failed");
      }
      return res.json();
    })
    .then((config) => {
      if (typeof config.clientMinIntervalMs === "number") {
        MIN_REQUEST_INTERVAL_MS = config.clientMinIntervalMs;
        console.log(`[Config] Client min interval set to: ${MIN_REQUEST_INTERVAL_MS}ms`);
      }
    })
    .catch((err) => {
      console.warn("[Config] Failed to load config, using default:", err);
    });
}

if ("geolocation" in navigator) {
  const options = { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 };

  function requestPosition(force = false) {
    // 手動リクエスト用
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        handleNewLocation(pos.coords.latitude, pos.coords.longitude, force);
      },
      (err) => {
        console.error("[Geolocation] getCurrentPosition error:", err);
        coordsEl.textContent = "Lat: unavailable, Lng: unavailable";
        lastUpdatedEl.textContent = "Last update: error";
      },
      options
    );
  }

  let watchId = null;

  function startWatching() {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
    }
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        // OSから位置情報が届くたびに処理
        handleNewLocation(pos.coords.latitude, pos.coords.longitude, false);
      },
      (err) => {
        console.error("[Geolocation] watchPosition error:", err);
      },
      options
    );
  }

  // 初期化中の表示
  coordsEl.textContent = "Lat: locating..., Lng: locating...";

  // 設定を読み込んでから位置情報取得を開始
  loadConfig().then(async () => {
    await loadCurrentUserId();
    // 監視を開始
    startWatching();
    
    // 2秒おきに最新の位置情報を読み取って送信する（ポーリング）
    setInterval(pollAndSendLocation, 2000);

    updateRecordButton();
    if (toggleShowMapInfoBtn) {
      toggleShowMapInfoBtn.checked = false;
    }
    
    // レコードボタンのイベントハンドラー
    toggleRecordBtn.addEventListener("change", async () => {
      if (isHandlingRecordToggle) {
        updateRecordButton();
        return;
      }
      isHandlingRecordToggle = true;
      toggleRecordBtn.disabled = true;

      const nextEnabled = toggleRecordBtn.checked;
      try {
        if (nextEnabled) {
          // レコードON：前回の黄緑線を削除し、新しいセッション開始
          if (tracePolyline) {
            map.removeLayer(tracePolyline);
            tracePolyline = null;
          }
          recordedRawPoints = [];
          currentSessionId = generateUUID();
          currentSessionStartedAt = new Date().toISOString();
          await postSessionLifecycle("start", {
            sessionId: currentSessionId,
            startedAt: currentSessionStartedAt,
          });
          recordEnabled = true;
          updateRecordButton();
          console.log(`[Record] Started recording session=${currentSessionId}`);
        } else {
          // レコードOFF：確認モーダルで保存可否を決定
          const finishedSessionId = currentSessionId;
          recordEnabled = false;

          // 過去のドットをすべて黒色に変更
          trail.forEach((dot) => {
            dot.setStyle({ color: "#111", fillColor: "#111" });
          });

          updateRecordButton();
          console.log(`[Record] Stopped recording. ${recordedRawPoints.length} points collected. session=${finishedSessionId}`);
          currentSessionId = null;
          currentSessionStartedAt = null;
          await handleRecordStopWithConfirmation(finishedSessionId);
        }
      } finally {
        isHandlingRecordToggle = false;
        toggleRecordBtn.disabled = false;
      }
    });
    
    if (toggleShowMapInfoBtn) {
      toggleShowMapInfoBtn.addEventListener("change", () => {
        console.log(`[toggleShowMapInfo] showMapInfo=${toggleShowMapInfoBtn.checked}`);
        applyMapInfoVisibility();
      });
    }
    // 初期化中にユーザーが先にトグルを変更した場合でも表示状態を同期する。
    applyMapInfoVisibility();

    // 現在地の中央表示トグル（ログのみ）
    if (toggleCenterCurrentBtn) {
      toggleCenterCurrentBtn.addEventListener("change", () => {
        console.log(`[toggleCenterCurrent] centerCurrentLocation=${toggleCenterCurrentBtn.checked}`);
        recenterToLatestLocation();
      });
    }
    
  });
} else {
  coordsEl.textContent = "Lat: unavailable, Lng: unavailable";
  lastUpdatedEl.textContent = "Last update: --:--:--";
}
