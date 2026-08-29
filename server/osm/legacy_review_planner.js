const { replay, projectToSegment, inferWaySide, signedOffsetMeters } = require("../fitting/browser_matcher");
const { createSplitPlan } = require("./split_planner");

function pointFromCoordinate(coordinate) {
  return { lng: Number(coordinate[0]), lat: Number(coordinate[1]) };
}

function parseRecordedPath(metadata) {
  try {
    const path = JSON.parse(metadata.pathGeoJson || "null");
    if (path && path.type === "LineString" && Array.isArray(path.coordinates) && path.coordinates.length >= 2) {
      return path.coordinates.map(pointFromCoordinate).filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
    }
  } catch (_) {}
  return [];
}

function normalizeRawPoints(metadata) {
  return (Array.isArray(metadata.rawPoints) ? metadata.rawPoints : [])
    .map((point) => ({ lat: Number(point.lat), lng: Number(point.lng), accuracy: point.accuracy == null ? null : Number(point.accuracy) }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
}

function closestBoundary(point, way) {
  let best = null;
  for (let index = 0; index < way.coordinates.length - 1; index += 1) {
    const projected = projectToSegment(point, pointFromCoordinate(way.coordinates[index]), pointFromCoordinate(way.coordinates[index + 1]));
    if (!best || projected.distance < best.distance) best = {
      kind: "projection", segmentIndex: index, fraction: projected.fraction,
      coordinate: [projected.lng, projected.lat], distance: projected.distance,
    };
  }
  if (!best) throw new Error("legacy_boundary_not_found");
  return best;
}

function sharedNodeBoundary(way, adjacentWay, referencePoint) {
  const adjacentNodes = new Set(adjacentWay.nodes || []);
  const candidates = (way.nodes || []).flatMap((nodeId, index) => adjacentNodes.has(nodeId)
    ? [{ kind: "node", index, nodeRef: nodeId, coordinate: way.coordinates[index] }]
    : []);
  if (!candidates.length) throw new Error("legacy_route_not_connected");
  if (!referencePoint || candidates.length === 1) return candidates[0];
  return candidates.sort((left, right) => {
    const distance = (candidate) => Math.hypot(candidate.coordinate[0] - referencePoint.lng, candidate.coordinate[1] - referencePoint.lat);
    return distance(left) - distance(right);
  })[0];
}

function inferRoadSide(points, way) {
  const inferred = inferWaySide(points, way);
  if (inferred) return inferred;
  const offsets = [];
  for (const point of points) {
    let nearest = null;
    for (let index = 0; index < way.coordinates.length - 1; index += 1) {
      const start = pointFromCoordinate(way.coordinates[index]);
      const end = pointFromCoordinate(way.coordinates[index + 1]);
      const projected = projectToSegment(point, start, end);
      if (!nearest || projected.distance < nearest.distance) nearest = {
        distance: projected.distance,
        offset: signedOffsetMeters(point, start, end),
      };
    }
    if (nearest && nearest.distance <= 60) offsets.push(nearest.offset);
  }
  if (!offsets.length) throw new Error("legacy_side_not_inferable");
  return offsets.reduce((sum, offset) => sum + offset, 0) >= 0 ? "left" : "right";
}

function isIndependentWalkway(way) {
  return ["footway", "path", "pedestrian", "steps", "corridor"].includes(String(way.tags?.highway || "").toLowerCase())
    || String(way.tags?.footway || "").toLowerCase() === "sidewalk";
}

function createLegacyReviewPlan(metadata, ways) {
  const rawPoints = normalizeRawPoints(metadata || {});
  const recordedPath = parseRecordedPath(metadata || {});
  const fittingPoints = rawPoints.length >= 2 ? rawPoints : recordedPath;
  if (fittingPoints.length < 2) throw new Error("legacy_points_not_available");
  const fitting = replay(fittingPoints, ways);
  if (!fitting.routeConfirmed || fitting.coverage < 0.8 || !fitting.wayIds.length) throw new Error("legacy_route_not_confirmed");
  const byId = new Map(ways.map((way) => [Number(way.id), way]));
  const routeWays = fitting.wayIds.map((wayId) => byId.get(Number(wayId)));
  if (routeWays.some((way) => !way)) throw new Error("legacy_route_way_missing");
  const boundaryPoints = recordedPath.length >= 2 ? recordedPath : fittingPoints;
  const segments = routeWays.map((way, index) => {
    const previous = routeWays[index - 1] || null;
    const next = routeWays[index + 1] || null;
    const from = previous
      ? sharedNodeBoundary(way, previous, boundaryPoints[0])
      : closestBoundary(boundaryPoints[0], way);
    const to = next
      ? sharedNodeBoundary(way, next, boundaryPoints.at(-1))
      : closestBoundary(boundaryPoints.at(-1), way);
    return {
      wayId: way.id,
      wayVersion: way.version,
      nodes: way.nodes,
      fullCoordinates: way.coordinates,
      tags: way.tags || {},
      relations: way.relations || [],
      allowMissingTactile: true,
      side: isIndependentWalkway(way) ? null : inferRoadSide(fittingPoints, way),
      from,
      to,
    };
  });
  const splitPlan = createSplitPlan({ segments }, { tactileValue: "yes" });
  return { fitting, segments, splitPlan };
}

module.exports = { createLegacyReviewPlan, parseRecordedPath, normalizeRawPoints, closestBoundary, sharedNodeBoundary, inferRoadSide };
