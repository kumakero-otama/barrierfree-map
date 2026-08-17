const { createOsmApiClient } = require("./osm_api_client");

function changesetMetadata(summary) {
  const hashtag = String(process.env.OSM_CHANGESET_HASHTAG || "#StepBy").trim() || "#StepBy";
  const wikiUrl = String(process.env.OSM_AUTOMATED_EDIT_WIKI_URL || "").trim();
  const automatedTag = String(process.env.OSM_AUTOMATED_EDIT_TAG || "mechanical").trim() === "bot" ? "bot" : "mechanical";
  return {
    created_by: `StepBy ${String(process.env.STEPBY_VERSION || "development").trim()}`,
    comment: `${String(summary || "StepBy field survey: tactile paving confirmed").trim()} ${hashtag}`.trim(),
    source: "survey",
    description: wikiUrl,
    [automatedTag]: "yes",
  };
}

function normalizedObject(value) {
  if (Array.isArray(value)) return value.map(normalizedObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizedObject(value[key])]));
}

function equalJson(left, right) {
  return JSON.stringify(normalizedObject(left)) === JSON.stringify(normalizedObject(right));
}

function unchangedExceptVersion(operation, snapshot) {
  const before = operation.before || {};
  if (operation.elementType === "way") {
    return equalJson((before.nodes || []).map(Number), snapshot.nodes || []) && equalJson(before.tags || {}, snapshot.tags || {});
  }
  if (operation.elementType === "relation") {
    return equalJson(before.members || [], snapshot.members || []) && equalJson(before.tags || {}, snapshot.tags || {});
  }
  if (operation.elementType === "node") {
    const lat = Number(before.lat == null && Array.isArray(before.coordinate) ? before.coordinate[1] : before.lat);
    const lng = Number(before.lng == null && Array.isArray(before.coordinate) ? before.coordinate[0] : before.lng);
    return Number.isFinite(lat) && Number.isFinite(lng)
      && Math.abs(lat - Number(snapshot.lat)) < 1e-7 && Math.abs(lng - Number(snapshot.lng)) < 1e-7
      && equalJson(before.tags || {}, snapshot.tags || {});
  }
  return false;
}

function executeWithClient({ client, operations, summary, planId, operationType, onChangesetCreated, onVersionsRebased }) {
  return (async () => {
    const executionOperations = operations.map((operation) => ({ ...operation }));
    const versionRebases = [];
    for (const operation of executionOperations) {
      if (operation.action === "create") continue;
      const snapshot = typeof client.fetchElementSnapshot === "function"
        ? await client.fetchElementSnapshot(operation.elementType, operation.osmId)
        : null;
      const currentVersion = snapshot ? snapshot.version : await client.fetchElementVersion(operation.elementType, operation.osmId);
      if (Number(currentVersion) !== Number(operation.version)) {
        if (snapshot && unchangedExceptVersion(operation, snapshot)) {
          versionRebases.push({ elementType: operation.elementType, osmId: operation.osmId, fromVersion: operation.version, toVersion: currentVersion });
          operation.version = currentVersion;
          continue;
        }
        const error = new Error("osm_version_conflict");
        error.elementType = operation.elementType;
        error.osmId = operation.osmId;
        error.expectedVersion = operation.version;
        error.currentVersion = currentVersion;
        throw error;
      }
    }
    if (versionRebases.length && onVersionsRebased) await onVersionsRebased(versionRebases);
    const changesetId = await client.createChangeset(changesetMetadata(summary));
    if (onChangesetCreated) {
      try {
        await onChangesetCreated(changesetId);
      } catch (error) {
        try { await client.closeChangeset(changesetId); } catch (_) {}
        error.changesetId = changesetId;
        throw error;
      }
    }
    let upload;
    let closeError = null;
    try {
      upload = await client.uploadChangeset(changesetId, executionOperations);
    } catch (error) {
      error.changesetId = changesetId;
      throw error;
    } finally {
      try { await client.closeChangeset(changesetId); }
      catch (error) { closeError = error; }
    }
    if (!upload) throw new Error("osm_upload_failed");
    return {
      changesetId,
      temporaryIds: upload.temporaryIds,
      diffResult: upload.diffResult,
      versionRebases,
      closeError: closeError ? closeError.message : null,
    };
  })();
}

function createConfiguredClient() {
  return createOsmApiClient({
    baseUrl: process.env.OSM_API_BASE_URL,
    accessToken: process.env.OSM_ACCESS_TOKEN,
  });
}

module.exports = { executeWithClient, createConfiguredClient, changesetMetadata, unchangedExceptVersion };
