function coordinatesFromOperation(operation) {
  const data = operation.after || operation.before || {};
  const values = [];
  if (Number.isFinite(Number(data.lat)) && Number.isFinite(Number(data.lng))) values.push([Number(data.lng), Number(data.lat)]);
  (Array.isArray(data.coordinates) ? data.coordinates : []).forEach((coordinate) => {
    if (Array.isArray(coordinate) && Number.isFinite(Number(coordinate[0])) && Number.isFinite(Number(coordinate[1]))) values.push([Number(coordinate[0]), Number(coordinate[1])]);
  });
  return values;
}

function tagMap(operation) {
  return { ...((operation.before && operation.before.tags) || {}), ...((operation.after && operation.after.tags) || {}) };
}

function matchesRule(rule, operation, metadata) {
  const value = rule.rule_value && typeof rule.rule_value === "object" ? rule.rule_value : {};
  if (rule.rule_type === "way") return operation.elementType === "way" && Number(operation.osmId) === Number(value.wayId);
  if (rule.rule_type === "osm_user") return Number(metadata && metadata.userId) === Number(value.osmUserId);
  if (rule.rule_type === "tag") {
    const tags = tagMap(operation);
    return typeof value.key === "string" && Object.prototype.hasOwnProperty.call(tags, value.key)
      && (value.value == null || String(tags[value.key]) === String(value.value));
  }
  if (rule.rule_type === "region") {
    const bbox = Array.isArray(value.bbox) ? value.bbox.map(Number) : [];
    if (bbox.length !== 4 || bbox.some((item) => !Number.isFinite(item))) return false;
    return coordinatesFromOperation(operation).some(([lng, lat]) => lng >= bbox[0] && lat >= bbox[1] && lng <= bbox[2] && lat <= bbox[3]);
  }
  return false;
}

async function ensureOptOutSchema(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS osmchange.opt_out_rules (
    rule_id UUID PRIMARY KEY,
    rule_type TEXT NOT NULL CHECK (rule_type IN ('way','osm_user','region','tag')),
    rule_value JSONB NOT NULL,
    reason TEXT NOT NULL,
    source_url TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}

async function findOptOutMatch(pool, plan, client) {
  const [rules] = await pool.query(`SELECT rule_id,rule_type,rule_value,reason,source_url
    FROM osmchange.opt_out_rules WHERE active=TRUE ORDER BY created_at,rule_id`);
  if (!rules.length) return null;
  for (const operation of plan.elements) {
    let metadata = null;
    if (operation.action !== "create" && typeof client.fetchElementMetadata === "function") metadata = await client.fetchElementMetadata(operation.elementType, operation.osmId);
    const matched = rules.find((rule) => matchesRule(rule, operation, metadata));
    if (matched) return { rule: matched, operation: { elementType: operation.elementType, osmId: operation.osmId || null } };
  }
  return null;
}

module.exports = { coordinatesFromOperation, matchesRule, ensureOptOutSchema, findOptOutMatch };
