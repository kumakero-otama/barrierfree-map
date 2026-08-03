function escapeXml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function tagsXml(tags) {
  return Object.entries(tags || {})
    .filter(([, value]) => value != null)
    .map(([key, value]) => `<tag k="${escapeXml(key)}" v="${escapeXml(value)}"/>`)
    .join("");
}

function memberXml(member, temporaryIds) {
  const rawRef = member.ref == null ? member.id : member.ref;
  const ref = temporaryIds.get(String(rawRef)) || rawRef;
  return `<member type="${escapeXml(member.type)}" ref="${escapeXml(ref)}" role="${escapeXml(member.role || "")}"/>`;
}

function elementXml(operation, changesetId, temporaryIds) {
  const data = operation.action === "delete" ? operation.before : operation.after;
  const temporaryId = data && data.temporaryId;
  const id = operation.action === "create"
    ? temporaryIds.get(String(temporaryId))
    : operation.osmId;
  const version = operation.action === "create" ? null : operation.version;
  const common = `id="${escapeXml(id)}" changeset="${escapeXml(changesetId)}"${version == null ? "" : ` version="${escapeXml(version)}"`}`;
  if (operation.elementType === "node") {
    if (!data || !Number.isFinite(Number(data.lat)) || !Number.isFinite(Number(data.lng))) throw new Error("invalid_node_payload");
    return `<node ${common} lat="${escapeXml(data.lat)}" lon="${escapeXml(data.lng)}">${tagsXml(data.tags)}</node>`;
  }
  if (operation.elementType === "way") {
    const refs = Array.isArray(data && data.nodes) ? data.nodes : [];
    if (refs.length < 2) throw new Error("invalid_way_payload");
    const nds = refs.map((ref) => `<nd ref="${escapeXml(temporaryIds.get(String(ref)) || ref)}"/>`).join("");
    return `<way ${common}>${nds}${tagsXml(data.tags)}</way>`;
  }
  if (operation.elementType === "relation") {
    const members = Array.isArray(data && data.members) ? data.members : [];
    return `<relation ${common}>${members.map((member) => memberXml(member, temporaryIds)).join("")}${tagsXml(data && data.tags)}</relation>`;
  }
  throw new Error("invalid_element_type");
}

function assignTemporaryIds(operations) {
  const ids = new Map();
  let next = -1;
  operations.forEach((operation) => {
    if (operation.action !== "create") return;
    const temporaryId = operation.after && operation.after.temporaryId;
    if (!temporaryId) throw new Error("missing_temporary_id");
    if (ids.has(String(temporaryId))) throw new Error("duplicate_temporary_id");
    ids.set(String(temporaryId), next);
    next -= 1;
  });
  return ids;
}

function buildOsmChangeXml(operations, changesetId) {
  if (!Array.isArray(operations) || !operations.length) throw new Error("invalid_operations");
  const temporaryIds = assignTemporaryIds(operations);
  const groups = { create: [], modify: [], delete: [] };
  operations.forEach((operation) => groups[operation.action].push(elementXml(operation, changesetId, temporaryIds)));
  const sections = ["create", "modify", "delete"].filter((action) => groups[action].length)
    .map((action) => `<${action}${action === "delete" ? ' if-unused="true"' : ""}>${groups[action].join("")}</${action}>`)
    .join("");
  return {
    xml: `<?xml version="1.0" encoding="UTF-8"?><osmChange version="0.6" generator="StepBy">${sections}</osmChange>`,
    temporaryIds: Object.fromEntries(temporaryIds),
  };
}

function buildChangesetXml(tags) {
  return `<?xml version="1.0" encoding="UTF-8"?><osm version="0.6" generator="StepBy"><changeset>${tagsXml(tags)}</changeset></osm>`;
}

function parseDiffResult(xml) {
  const results = [];
  const pattern = /<(node|way|relation)\s+([^>]*?)\/>/g;
  let match;
  while ((match = pattern.exec(String(xml || "")))) {
    const attrs = {};
    String(match[2]).replace(/([a-z_]+)="([^"]*)"/g, (_, key, value) => { attrs[key] = value; return ""; });
    results.push({
      elementType: match[1],
      oldId: Number(attrs.old_id),
      newId: Number(attrs.new_id),
      newVersion: Number(attrs.new_version),
    });
  }
  return results;
}

function createOsmApiClient({ baseUrl, accessToken, fetchImpl = global.fetch }) {
  if (!baseUrl || !accessToken || typeof fetchImpl !== "function") throw new Error("osm_client_not_configured");
  const root = String(baseUrl).replace(/\/$/, "");
  async function call(path, options = {}) {
    const response = await fetchImpl(`${root}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "text/xml; charset=utf-8", ...(options.headers || {}) },
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`osm_http_${response.status}`);
      error.status = response.status;
      error.responseBody = text.slice(0, 2000);
      throw error;
    }
    return text;
  }
  return {
    async fetchElementVersion(elementType, osmId) {
      if (!['node', 'way', 'relation'].includes(elementType) || !Number.isSafeInteger(Number(osmId)) || Number(osmId) <= 0) {
        throw new Error("invalid_element_identity");
      }
      const xml = await call(`/api/0.6/${elementType}/${osmId}`, { method: "GET" });
      const match = new RegExp(`<${elementType}\\s+[^>]*id="${Number(osmId)}"[^>]*version="(\\d+)"`).exec(xml)
        || new RegExp(`<${elementType}\\s+[^>]*version="(\\d+)"[^>]*id="${Number(osmId)}"`).exec(xml);
      if (!match) throw new Error("invalid_osm_element_response");
      return Number(match[1]);
    },
    async createChangeset(tags) {
      const id = Number(await call("/api/0.6/changeset/create", { method: "PUT", body: buildChangesetXml(tags) }));
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error("invalid_changeset_id");
      return id;
    },
    async uploadChangeset(changesetId, operations) {
      const built = buildOsmChangeXml(operations, changesetId);
      const responseXml = await call(`/api/0.6/changeset/${changesetId}/upload`, { method: "POST", body: built.xml });
      return { ...built, diffResult: parseDiffResult(responseXml), responseXml };
    },
    async closeChangeset(changesetId) {
      await call(`/api/0.6/changeset/${changesetId}/close`, { method: "PUT", body: "" });
    },
  };
}

module.exports = { buildChangesetXml, buildOsmChangeXml, parseDiffResult, createOsmApiClient };
