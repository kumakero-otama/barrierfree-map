const map = L.map("map", { zoomControl: true }).setView([35.681236, 139.767125], 13);
const coordsEl = document.getElementById("coords");
const rawCoordsEl = document.getElementById("raw-coords");
const lastUpdatedEl = document.getElementById("last-updated");
const matchCountEl = document.getElementById("match-count");
const reloadBtn = document.getElementById("reload-location");
const toggleRecordBtn = document.getElementById("toggle-record");
const toggleShowAllBtn = document.getElementById("toggle-show-all");

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

const redPinIcon = L.icon({
  iconUrl: "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

const MAX_SAMPLES = 5;
let MIN_REQUEST_INTERVAL_MS = 5000; // デフォルト値、サーバーから取得して上書き
const samples = [];
let marker = null;
const trail = [];
const MAX_TRAIL = 100;
let lastDot = null;
let lastSent = null;
let lastRequestTime = 0;
let recordEnabled = false;
let currentSessionUuid = null;
let sessionPointSeq = 0;
const deviceUuid = getOrCreateDeviceUuid();
let showAllRecords = false;
let allRecordsMarkers = [];

// UUID v4 生成関数
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function getOrCreateDeviceUuid() {
  const key = "deviceUuid";
  try {
    const existing = localStorage.getItem(key);
    if (existing) {
      return existing;
    }
    const created = generateUUID();
    localStorage.setItem(key, created);
    return created;
  } catch {
    return generateUUID();
  }
}

function updateRecordButton() {
  toggleRecordBtn.checked = recordEnabled;
}

// レコード状態をlocalStorageに保存
function saveRecordState() {
  try {
    if (recordEnabled && currentSessionUuid) {
      localStorage.setItem("recordState", JSON.stringify({
        sessionUuid: currentSessionUuid,
        userId: deviceUuid,
        timestamp: Date.now()
      }));
    } else {
      localStorage.removeItem("recordState");
    }
  } catch (err) {
    console.warn("[saveRecordState] failed:", err);
  }
}

// アプリ起動時に前回のレコード状態をチェックして自動クリーンアップ
function checkAndCleanupRecordState() {
  try {
    const savedState = localStorage.getItem("recordState");
    if (savedState) {
      const state = JSON.parse(savedState);
      console.log("[checkAndCleanupRecordState] Found previous recording session:", state);
      
      // 前回のセッションを自動的に保存（アプリが異常終了したと判断）
      // セッションは既にDBに記録されているので、削除しない
      localStorage.removeItem("recordState");
      console.log("[checkAndCleanupRecordState] Previous session auto-saved");
    }
  } catch (err) {
    console.warn("[checkAndCleanupRecordState] failed:", err);
    localStorage.removeItem("recordState");
  }
}

function finalizeSession(sessionUuid, userId, shouldSave) {
  if (!sessionUuid || !userId) {
    return Promise.resolve();
  }
  if (shouldSave) {
    // 保存する場合もlocalStorageをクリア
    localStorage.removeItem("recordState");
    return Promise.resolve();
  }
  // 削除する場合
  localStorage.removeItem("recordState");
  const endpoint = "/api/session/delete";
  const payload = { sessionUuid, userId };
  return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch((err) => {
    console.warn("[finalizeSession] request failed:", err);
  });
}

// ページアンロード時の処理（アプリ閉じ、電源OFF時など）
function handleBeforeUnload(event) {
  if (recordEnabled && currentSessionUuid) {
    console.log("[beforeunload] Auto-saving recording session");
    // セッションを自動保存（削除しない）
    // navigator.sendBeaconを使用して確実に送信
    const endpoint = "/api/session/end";
    const payload = JSON.stringify({
      sessionUuid: currentSessionUuid,
      note: "auto_closed"
    });
    
    // sendBeaconで送信を試みる
    if (navigator.sendBeacon) {
      navigator.sendBeacon(endpoint, new Blob([payload], { type: "application/json" }));
    }
    
    // localStorageもクリア
    localStorage.removeItem("recordState");
  }
}

function updateCount() {
  fetch("/api/count")
    .then((res) => {
      if (!res.ok) {
        throw new Error("count failed");
      }
      return res.json();
    })
    .then((data) => {
      if (typeof data.count === "number" && data.month) {
        matchCountEl.textContent = `Match calls (${data.month}): ${data.count}`;
      }
    })
    .catch(() => {
      // leave as-is on failure
    });
}

function requestSnappedLocation(latitude, longitude) {
  // クライアント側のレート制限チェック
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL_MS) {
    console.log(`[requestSnappedLocation] Rate limited (client-side): ${timeSinceLastRequest}ms < ${MIN_REQUEST_INTERVAL_MS}ms`);
    return;
  }
  lastRequestTime = now;

  const params = new URLSearchParams({
    lat: latitude.toString(),
    lng: longitude.toString(),
    deviceUuid: deviceUuid,
  });
  
  if (lastSent) {
    params.set("prevLat", lastSent.latitude.toString());
    params.set("prevLng", lastSent.longitude.toString());
  }
  
  // レコードON時のみセッションUUID、userId、seqを追加
  if (recordEnabled && currentSessionUuid) {
    params.set("sessionUuid", currentSessionUuid);
    params.set("userId", deviceUuid);
    params.set("seq", sessionPointSeq.toString());
  }

  console.log(`[requestSnappedLocation] Requesting: lat=${latitude}, lng=${longitude}`);

  fetch(`/api/match?${params.toString()}`)
    .then((res) => {
      console.log(`[requestSnappedLocation] Response status: ${res.status}`);
      if (res.status === 204) {
        console.log('[requestSnappedLocation] Received 204 No Content - no update');
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
        // セッションポイントのseqをインクリメント
        if (recordEnabled && currentSessionUuid) {
          sessionPointSeq++;
        }
      } else {
        console.warn('[requestSnappedLocation] Invalid data format:', data);
        return;
      }
      if (typeof data.count === "number" && data.month) {
        matchCountEl.textContent = `Match calls (${data.month}): ${data.count}`;
      }
    })
    .catch((error) => {
      console.error('[requestSnappedLocation] Error:', error);
      // keep current display on failure
    });
}

function updateAverageLocation(latitude, longitude) {
  samples.push({ latitude, longitude });
  if (samples.length > MAX_SAMPLES) {
    samples.shift();
  }

  const sum = samples.reduce(
    (acc, cur) => {
      acc.lat += cur.latitude;
      acc.lng += cur.longitude;
      return acc;
    },
    { lat: 0, lng: 0 }
  );
  const avgLat = sum.lat / samples.length;
  const avgLng = sum.lng / samples.length;

  requestSnappedLocation(avgLat, avgLng);
}

function updateDisplay(rawLat, rawLng, snappedLat, snappedLng) {
  console.log(`[updateDisplay] Updating display: raw=(${rawLat}, ${rawLng}), snapped=(${snappedLat}, ${snappedLng})`);
  
  // 座標の妥当性チェック
  if (!Number.isFinite(snappedLat) || !Number.isFinite(snappedLng)) {
    console.error('[updateDisplay] Invalid snapped coordinates:', snappedLat, snappedLng);
    return;
  }
  
  coordsEl.textContent = `Lat: ${snappedLat.toFixed(6)}, Lng: ${snappedLng.toFixed(6)}`;
  rawCoordsEl.textContent = `Raw: ${rawLat.toFixed(6)}, ${rawLng.toFixed(6)}`;
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  lastUpdatedEl.textContent = `Last update: ${hh}:${mm}:${ss}`;
  
  // マーカーの更新
  if (!marker) {
    console.log('[updateDisplay] Creating new marker');
    marker = L.marker([snappedLat, snappedLng], { icon: redPinIcon }).addTo(map);
  } else {
    console.log('[updateDisplay] Updating existing marker position');
    marker.setLatLng([snappedLat, snappedLng]);
  }
  
  // 地図の表示位置を更新
  const currentZoom = map.getZoom();
  console.log(`[updateDisplay] Moving map to (${snappedLat}, ${snappedLng}) with zoom ${currentZoom}`);
  map.setView([snappedLat, snappedLng], currentZoom, { animate: true });

  // ドット（点）だけを表示
  const dot = L.circleMarker([snappedLat, snappedLng], {
    radius: 3,
    color: "#111",
    fillColor: "#111",
    fillOpacity: 0.7,
    weight: 0,
  }).addTo(map);
  
  trail.push(dot);
  if (trail.length > MAX_TRAIL) {
    map.removeLayer(trail.shift());
  }
  
  console.log('[updateDisplay] Display update complete');
}

// 全レコードを取得して表示
function loadAndShowAllRecords() {
  console.log("[loadAndShowAllRecords] Fetching all records...");
  fetch("/api/records")
    .then((res) => {
      if (!res.ok) {
        throw new Error(`records fetch failed: ${res.status}`);
      }
      return res.json();
    })
    .then((data) => {
      console.log(`[loadAndShowAllRecords] Loaded ${data.count} points`);
      if (data.success && Array.isArray(data.points)) {
        showAllRecordsOnMap(data.points);
      }
    })
    .catch((err) => {
      console.error("[loadAndShowAllRecords] Error:", err);
      alert("全レコードの取得に失敗しました。");
    });
}

// 全レコードを地図上に表示
function showAllRecordsOnMap(points) {
  // 既存のマーカーをクリア
  clearAllRecordsFromMap();
  
  console.log(`[showAllRecordsOnMap] Showing ${points.length} points`);
  
  // セッションごとにポイントをグループ化
  const sessionMap = new Map();
  points.forEach((point) => {
    const sessionUuid = point.session_uuid;
    if (!sessionMap.has(sessionUuid)) {
      sessionMap.set(sessionUuid, []);
    }
    sessionMap.get(sessionUuid).push(point);
  });
  
  console.log(`[showAllRecordsOnMap] Found ${sessionMap.size} sessions`);
  
  // 各セッションごとに処理
  sessionMap.forEach((sessionPoints, sessionUuid) => {
    // seqでソート
    sessionPoints.sort((a, b) => a.seq - b.seq);
    
    // ポイントの座標を抽出
    const coordinates = [];
    sessionPoints.forEach((point) => {
      const lat = parseFloat(point.lat);
      const lng = parseFloat(point.lng);
      
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        coordinates.push([lat, lng]);
        
        // 小さな点を表示
        const marker = L.circleMarker([lat, lng], {
          radius: 2,
          color: "#0066ff",
          fillColor: "#0066ff",
          fillOpacity: 0.5,
          weight: 1,
        }).addTo(map);
        
        allRecordsMarkers.push(marker);
      }
    });
    
    // セッションの軌跡を青い線で描画
    if (coordinates.length > 1) {
      const polyline = L.polyline(coordinates, {
        color: "#0066ff",
        weight: 2,
        opacity: 0.6,
      }).addTo(map);
      
      allRecordsMarkers.push(polyline);
    }
  });
  
  console.log(`[showAllRecordsOnMap] Displayed ${allRecordsMarkers.length} items (markers + lines)`);
}

// 全レコードを地図から削除
function clearAllRecordsFromMap() {
  console.log(`[clearAllRecordsFromMap] Removing ${allRecordsMarkers.length} markers`);
  allRecordsMarkers.forEach((marker) => {
    map.removeLayer(marker);
  });
  allRecordsMarkers = [];
}

// サーバーから設定を取得
function loadConfig() {
  return fetch("/api/config")
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

  function requestPosition() {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        updateAverageLocation(pos.coords.latitude, pos.coords.longitude);
      },
      () => {
        coordsEl.textContent = "Lat: unavailable, Lng: unavailable";
        lastUpdatedEl.textContent = "Last update: --:--:--";
      },
      options
    );
  }

  // 設定を読み込んでから位置情報取得を開始
  loadConfig().then(() => {
    // アプリ起動時に前回のレコード状態をチェック
    checkAndCleanupRecordState();
    
    requestPosition();
    setInterval(requestPosition, 5000);
    reloadBtn.addEventListener("click", requestPosition);
    updateRecordButton();
    toggleRecordBtn.addEventListener("change", () => {
      const nextEnabled = toggleRecordBtn.checked;
      if (nextEnabled) {
        recordEnabled = true;
        updateRecordButton();
        // レコードON時に新しいセッションUUIDを生成
        currentSessionUuid = generateUUID();
        sessionPointSeq = 0;
        console.log("Session started:", currentSessionUuid);
        // レコード状態を保存
        saveRecordState();
      } else {
        const sessionUuid = currentSessionUuid;
        recordEnabled = false;
        updateRecordButton();
        const shouldSave = window.confirm("記録を保存しますか？");
        finalizeSession(sessionUuid, deviceUuid, shouldSave);
        // レコードOFF時にセッションUUIDをクリア
        console.log("Session ended:", sessionUuid, "saved:", shouldSave);
        currentSessionUuid = null;
        sessionPointSeq = 0;
      }
    });
    
    // ページアンロード時のイベントリスナーを追加
    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("pagehide", handleBeforeUnload);
    
    // バックグラウンド移行時にも状態を保存
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && recordEnabled && currentSessionUuid) {
        console.log("[visibilitychange] Saving record state");
        saveRecordState();
      }
    });
    
    // 全レコード表示トグルのイベントリスナー
    toggleShowAllBtn.addEventListener("change", () => {
      showAllRecords = toggleShowAllBtn.checked;
      if (showAllRecords) {
        console.log("[toggleShowAll] Showing all records");
        loadAndShowAllRecords();
      } else {
        console.log("[toggleShowAll] Hiding all records");
        clearAllRecordsFromMap();
      }
    });
    
    updateCount();
    setInterval(updateCount, 5000);
  });
} else {
  coordsEl.textContent = "Lat: unavailable, Lng: unavailable";
  lastUpdatedEl.textContent = "Last update: --:--:--";
}
