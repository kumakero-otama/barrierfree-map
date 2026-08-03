const { createOsmApiClient } = require("./osm_api_client");

function executeWithClient({ client, operations, summary, planId, operationType, onChangesetCreated }) {
  return (async () => {
    for (const operation of operations) {
      if (operation.action === "create") continue;
      const currentVersion = await client.fetchElementVersion(operation.elementType, operation.osmId);
      if (Number(currentVersion) !== Number(operation.version)) {
        const error = new Error("osm_version_conflict");
        error.elementType = operation.elementType;
        error.osmId = operation.osmId;
        error.expectedVersion = operation.version;
        error.currentVersion = currentVersion;
        throw error;
      }
    }
    const changesetId = await client.createChangeset({
      created_by: "StepBy",
      comment: summary,
      source: "survey;StepBy",
      "stepby:plan_id": planId,
      "stepby:operation": operationType,
    });
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
      upload = await client.uploadChangeset(changesetId, operations);
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

module.exports = { executeWithClient, createConfiguredClient };
