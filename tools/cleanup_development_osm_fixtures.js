const crypto = require("crypto");
const { createDbPool } = require("../server/db");
const { createUserOsmClient } = require("../server/osm/user_oauth_client");
const { executeWithClient } = require("../server/osm/osm_executor");

const changesetIds = process.argv.slice(2, -1).map(Number).filter(Number.isSafeInteger);
if (process.argv.at(-1) !== "--confirm-development-fixture-cleanup" || !changesetIds.length) {
  throw new Error("development_fixture_cleanup_confirmation_required");
}
if (process.env.OSM_API_BASE_URL !== "https://master.apis.dev.openstreetmap.org") throw new Error("development_osm_base_url_required");

function attrs(text) {
  return Object.fromEntries([...String(text).matchAll(/([a-z_]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));
}

async function run() {
  const { pool, error } = createDbPool();
  if (!pool) throw error || new Error("database_unavailable");
  const [rows] = await pool.query("SELECT user_id FROM login.osm_connections WHERE status='connected' ORDER BY connected_at LIMIT 1");
  const userId = Number(rows[0] && rows[0].user_id);
  const client = await createUserOsmClient(pool, userId);
  const cleaned = [];
  for (const changesetId of changesetIds) {
    const response = await fetch(`${process.env.OSM_API_BASE_URL}/api/0.6/changeset/${changesetId}/download`);
    const xml = await response.text();
    if (!response.ok) throw new Error(`changeset_download_failed:${changesetId}:${response.status}`);
    const nodes = [...xml.matchAll(/<node\s+([^>]+?)(?:\/>|>([\s\S]*?)<\/node>)/g)].map((match) => {
      const a = attrs(match[1]);
      return { id: Number(a.id), version: Number(a.version), lat: Number(a.lat), lng: Number(a.lon) };
    });
    const ways = [...xml.matchAll(/<way\s+([^>]+)>([\s\S]*?)<\/way>/g)].map((match) => {
      const a = attrs(match[1]);
      const body = match[2];
      return {
        id: Number(a.id), version: Number(a.version),
        nodes: [...body.matchAll(/<nd ref="(\d+)"/g)].map((item) => Number(item[1])),
        tags: Object.fromEntries([...body.matchAll(/<tag k="([^"]+)" v="([^"]*)"/g)].map((item) => [item[1], item[2]])),
      };
    });
    await executeWithClient({
      client, planId: crypto.randomUUID(), operationType: "development_fixture_cleanup",
      summary: `Remove failed StepBy development fixture from changeset ${changesetId}`,
      operations: [
        ...ways.map((way) => ({ elementType: "way", action: "delete", osmId: way.id, version: way.version, before: { nodes: way.nodes, tags: way.tags }, after: null })),
        ...nodes.map((node) => ({ elementType: "node", action: "delete", osmId: node.id, version: node.version, before: { lat: node.lat, lng: node.lng, tags: {} }, after: null })),
      ],
    });
    cleaned.push({ changesetId, ways: ways.length, nodes: nodes.length });
  }
  console.log(JSON.stringify({ success: true, cleaned }));
}

run().catch((error) => { console.error(error.message); process.exitCode = 1; });
