const map = L.map("map", { zoomControl: true }).setView([35.681236, 139.767125], 13);
const coordsEl = document.getElementById("coords");
const rawCoordsEl = document.getElementById("raw-coords");
const snappedCoordsEl = document.getElementById("snapped-coords");
const lastUpdatedEl = document.getElementById("last-updated");
const matchCountEl = document.getElementById("match-count");
const reloadBtn = document.getElementById("reload-location");
const toggleRecordBtn = document.getElementById("toggle-record");

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

const redPinIcon = L.icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  shadowSize: [41, 41],
});

const MAX_SAMPLES = 5;
const samples = [];
let marker = null;
const trail = [];
const MAX_TRAIL = 100;
let lastDot = null;
let lastSent = null;
let recordEnabled = false;
let currentSessionUuid = null;
let sessionPointSeq = 0;

// UUID v4 生成関数
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function updateRecordButton() {
  toggleRecordBtn.checked = recordEnabled;
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
  const params = new URLSearchParams({
    lat: latitude.toString(),
    lng: longitude.toString(),
  });
  if (lastSent) {
    params.set("prevLat", lastSent.latitude.toString());
    params.set("prevLng", lastSent.longitude.toString());
  }
  
  // セッションUUIDとseqを追加
  if (recordEnabled && currentSessionUuid) {
    params.set("sessionUuid", currentSessionUuid);
    params.set("seq", sessionPointSeq.toString());
  }

  fetch(`/api/match?${params.toString()}`)
    .then((res) => {
      if (res.status === 204) {
        return null;
      }
      if (!res.ok) {
        throw new Error("match failed");
      }
      return res.json();
    })
    .then((data) => {
      if (!data) {
        return;
      }
      if (typeof data.lat === "number" && typeof data.lng === "number") {
        updateDisplay(latitude, longitude, data.lat, data.lng);
        // スナップされた座標を次回の基準点として保存
        lastSent = { latitude: data.lat, longitude: data.lng };
        // セッションポイントのseqをインクリメント
        if (recordEnabled && currentSessionUuid) {
          sessionPointSeq++;
        }
      } else {
        return;
      }
      if (typeof data.count === "number" && data.month) {
        matchCountEl.textContent = `Match calls (${data.month}): ${data.count}`;
      }
    })
    .catch(() => {
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
  coordsEl.textContent = `Lat: ${snappedLat.toFixed(6)}, Lng: ${snappedLng.toFixed(6)}`;
  rawCoordsEl.textContent = `Raw: ${rawLat.toFixed(6)}, ${rawLng.toFixed(6)}`;
  snappedCoordsEl.textContent = `Snapped: ${snappedLat.toFixed(6)}, ${snappedLng.toFixed(6)}`;
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  lastUpdatedEl.textContent = `Last update: ${hh}:${mm}:${ss}`;
  if (!marker) {
    marker = L.marker([snappedLat, snappedLng], { icon: redPinIcon }).addTo(map);
  } else {
    marker.setLatLng([snappedLat, snappedLng]);
  }
  map.setView([snappedLat, snappedLng], map.getZoom(), { animate: true });

  const dot = L.circleMarker([snappedLat, snappedLng], {
    radius: 3,
    color: "#111",
    fillColor: "#111",
    fillOpacity: 0.7,
    weight: 0,
  }).addTo(map);
  if (lastDot) {
    const line = L.polyline([lastDot.getLatLng(), dot.getLatLng()], {
      color: "#111",
      weight: 3,
      opacity: 0.6,
    }).addTo(map);
    trail.push(line);
    if (trail.length > MAX_TRAIL) {
      map.removeLayer(trail.shift());
    }
  }
  trail.push(dot);
  if (trail.length > MAX_TRAIL) {
    map.removeLayer(trail.shift());
  }
  lastDot = dot;

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

  requestPosition();
  setInterval(requestPosition, 5000);
  reloadBtn.addEventListener("click", requestPosition);
  updateRecordButton();
  toggleRecordBtn.addEventListener("change", () => {
    recordEnabled = toggleRecordBtn.checked;
    updateRecordButton();

    if (recordEnabled) {
      // レコードON時に新しいセッションUUIDを生成
      currentSessionUuid = generateUUID();
      sessionPointSeq = 0;
      console.log("Session started:", currentSessionUuid);
    } else {
      // レコードOFF時にセッションUUIDをクリア
      console.log("Session ended:", currentSessionUuid);
      currentSessionUuid = null;
      sessionPointSeq = 0;
    }
  });
  updateCount();
  setInterval(updateCount, 5000);
} else {
  coordsEl.textContent = "Lat: unavailable, Lng: unavailable";
  lastUpdatedEl.textContent = "Last update: --:--:--";
}
