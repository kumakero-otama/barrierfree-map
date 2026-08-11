const EARTH_METERS_PER_DEGREE = 111320;

function distanceMeters(a, b) {
  const meanLat = ((a.lat + b.lat) / 2) * Math.PI / 180;
  return Math.hypot((b.lng - a.lng) * EARTH_METERS_PER_DEGREE * Math.cos(meanLat), (b.lat - a.lat) * EARTH_METERS_PER_DEGREE);
}

function projectToSegment(point, start, end) {
  const meanLat = ((point.lat + start.lat + end.lat) / 3) * Math.PI / 180;
  const scaleX = EARTH_METERS_PER_DEGREE * Math.cos(meanLat);
  const ax = (start.lng - point.lng) * scaleX, ay = (start.lat - point.lat) * EARTH_METERS_PER_DEGREE;
  const bx = (end.lng - point.lng) * scaleX, by = (end.lat - point.lat) * EARTH_METERS_PER_DEGREE;
  const vx = bx - ax, vy = by - ay, lengthSquared = vx * vx + vy * vy;
  const fraction = lengthSquared ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / lengthSquared)) : 0;
  const x = ax + fraction * vx, y = ay + fraction * vy;
  return { lat: point.lat + y / EARTH_METERS_PER_DEGREE, lng: point.lng + x / scaleX, distance: Math.hypot(x, y), fraction };
}

function sharesNode(a, b) {
  const nodes = new Set((a && a.nodes) || []);
  return Boolean(a && b && (b.nodes || []).some((id) => nodes.has(id)));
}

function chooseBestMatch(point, ways, previousWayId) {
  const previousWay = ways.find((way) => way.id === previousWayId) || null;
  let best = null;
  for (const way of ways) for (let index = 0; index < (way.coordinates || []).length - 1; index += 1) {
    const projected = projectToSegment(point,
      { lng: way.coordinates[index][0], lat: way.coordinates[index][1] },
      { lng: way.coordinates[index + 1][0], lat: way.coordinates[index + 1][1] });
    if (projected.distance > 60) continue;
    const score = projected.distance + (way.priority === "pedestrian" ? 0 : 18) +
      (!previousWay ? 0 : way.id === previousWay.id ? 0 : sharesNode(way, previousWay) ? 3 : 14);
    if (!best || score < best.score) best = { ...projected, score, wayId: way.id, wayVersion: way.version,
      priority: way.priority, connectedToPrevious: !previousWay || way.id === previousWay.id || sharesNode(way, previousWay) };
  }
  return best;
}

function connectedPathExists(ways, ids) {
  if (!ids.length) return false;
  const byId = new Map(ways.map((way) => [way.id, way]));
  for (let i = 1; i < ids.length; i += 1) {
    if (ids[i] === ids[i - 1]) continue;
    const target = ids[i], queue = [ids[i - 1]], seen = new Set(queue);
    while (queue.length && !seen.has(target)) {
      const current = byId.get(queue.shift());
      for (const way of ways) if (!seen.has(way.id) && sharesNode(current, way)) { seen.add(way.id); queue.push(way.id); }
    }
    if (!seen.has(target)) return false;
  }
  return true;
}

function replay(points, ways) {
  const startedAt = Date.now();
  let previousWayId = null;
  const matches = points.map((point) => {
    const match = chooseBestMatch(point, ways, previousWayId);
    if (match) previousWayId = match.wayId;
    return match;
  });
  const valid = matches.filter(Boolean);
  const wayIds = valid.reduce((ids, match) => ids.at(-1) === match.wayId ? ids : [...ids, match.wayId], []);
  const missedPedestrianPriority = valid.filter((match, index) => {
    if (match.priority === "pedestrian") return false;
    return ways.some((way) => way.priority === "pedestrian" && chooseBestMatch(points[index], [way], null)?.distance <= 10);
  }).length;
  return { matches, wayIds, durationMs: Date.now() - startedAt, coverage: points.length ? valid.length / points.length : 0,
    connected: valid.every((match) => match.connectedToPrevious !== false) && connectedPathExists(ways, wayIds),
    pedestrianMatches: valid.filter((match) => match.priority === "pedestrian").length,
    missedPedestrianPriority,
    meanSnapDistance: valid.length ? valid.reduce((sum, match) => sum + match.distance, 0) / valid.length : null,
    maxSnapDistance: valid.length ? Math.max(...valid.map((match) => match.distance)) : null };
}

module.exports = { distanceMeters, projectToSegment, chooseBestMatch, replay };
