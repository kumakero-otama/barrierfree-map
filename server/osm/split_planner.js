const DEFAULT_NODE_SNAP_FRACTION = 1e-6;
const WALKABLE_WAY_HIGHWAYS = new Set(["footway", "path", "pedestrian", "steps", "corridor"]);

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`invalid_${label}`);
  return number;
}

function normalizeBoundary(raw, nodes, coordinates, snapFraction) {
  if (!raw || !["node", "projection"].includes(raw.kind)) throw new Error("invalid_boundary");
  if (raw.kind === "node") {
    const index = Number(raw.index);
    if (!Number.isInteger(index) || index < 0 || index >= nodes.length) throw new Error("invalid_node_boundary");
    return { kind: "node", index, position: index, nodeRef: nodes[index], coordinate: coordinates[index] };
  }
  const segmentIndex = Number(raw.segmentIndex);
  const fraction = finiteNumber(raw.fraction, "boundary_fraction");
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex >= nodes.length - 1 || fraction < 0 || fraction > 1) {
    throw new Error("invalid_projection_boundary");
  }
  if (fraction <= snapFraction) {
    return { kind: "node", index: segmentIndex, position: segmentIndex, nodeRef: nodes[segmentIndex], coordinate: coordinates[segmentIndex] };
  }
  if (fraction >= 1 - snapFraction) {
    return { kind: "node", index: segmentIndex + 1, position: segmentIndex + 1, nodeRef: nodes[segmentIndex + 1], coordinate: coordinates[segmentIndex + 1] };
  }
  const coordinate = Array.isArray(raw.coordinate) && raw.coordinate.length === 2
    ? [finiteNumber(raw.coordinate[0], "boundary_lng"), finiteNumber(raw.coordinate[1], "boundary_lat")]
    : [
      coordinates[segmentIndex][0] + (coordinates[segmentIndex + 1][0] - coordinates[segmentIndex][0]) * fraction,
      coordinates[segmentIndex][1] + (coordinates[segmentIndex + 1][1] - coordinates[segmentIndex][1]) * fraction,
    ];
  return { kind: "projection", segmentIndex, fraction, position: segmentIndex + fraction, coordinate };
}

function resolveTactileTagStrategy(segment, tactileValue) {
  const tags = segment && segment.tags && typeof segment.tags === "object" ? segment.tags : {};
  const highway = String(tags.highway || "").toLowerCase();
  const requestedSide = String(segment && (segment.side || segment.tactileSide) || "").toLowerCase();
  const independentWalkway = WALKABLE_WAY_HIGHWAYS.has(highway) || String(tags.footway || "").toLowerCase() === "sidewalk";
  if (independentWalkway) {
    return { kind: "independent_walkway", side: null, tags: { tactile_paving: tactileValue } };
  }
  if (!highway) throw new Error("missing_highway_tag");
  if (!new Set(["left", "right"]).has(requestedSide)) throw new Error("missing_side_for_roadway");
  return {
    kind: "roadway_sidewalk",
    side: requestedSide,
    tags: { [`sidewalk:${requestedSide}:tactile_paving`]: tactileValue },
  };
}

function planWay(segment, counters, options) {
  const wayId = Number(segment.wayId);
  const version = Number(segment.wayVersion);
  const nodes = Array.isArray(segment.nodes) ? [...segment.nodes] : [];
  const coordinates = Array.isArray(segment.fullCoordinates) ? segment.fullCoordinates.map((c) => [Number(c[0]), Number(c[1])]) : [];
  if (!Number.isSafeInteger(wayId) || wayId <= 0 || !Number.isInteger(version) || version <= 0) throw new Error("invalid_way_identity");
  if (nodes.length < 2 || nodes.length !== coordinates.length || coordinates.some((c) => !Number.isFinite(c[0]) || !Number.isFinite(c[1]))) {
    throw new Error("invalid_way_geometry");
  }
  const rawRanges = Array.isArray(segment.ranges) && segment.ranges.length
    ? segment.ranges
    : [{ from: segment.from, to: segment.to }];
  const ranges = rawRanges.map((range) => {
    const from = normalizeBoundary(range.from, nodes, coordinates, options.nodeSnapFraction);
    const to = normalizeBoundary(range.to, nodes, coordinates, options.nodeSnapFraction);
    if (Math.abs(from.position - to.position) < options.nodeSnapFraction) throw new Error("zero_length_tactile_segment");
    return { from, to, low: Math.min(from.position, to.position), high: Math.max(from.position, to.position) };
  });
  const from = ranges[0].from;
  const to = ranges[ranges.length - 1].to;

  const rawBoundaries = ranges.flatMap((range) => [range.from, range.to]).sort((a, b) => a.position - b.position);
  const boundaries = [];
  rawBoundaries.forEach((boundary) => {
    const existing = boundaries.find((item) => Math.abs(item.position - boundary.position) < options.nodeSnapFraction);
    if (existing) return;
    if (boundary.kind === "projection") {
      counters.node += 1;
      boundary.nodeRef = `new-node-${counters.node}`;
    }
    boundaries.push(boundary);
  });

  const insertedBySegment = new Map();
  boundaries.filter((b) => b.kind === "projection").forEach((boundary) => {
    if (!insertedBySegment.has(boundary.segmentIndex)) insertedBySegment.set(boundary.segmentIndex, []);
    insertedBySegment.get(boundary.segmentIndex).push(boundary);
  });
  insertedBySegment.forEach((items) => items.sort((a, b) => a.fraction - b.fraction));

  const expandedRefs = [];
  const expandedCoordinates = [];
  const expandedPositions = [];
  for (let index = 0; index < nodes.length; index += 1) {
    expandedRefs.push(nodes[index]);
    expandedCoordinates.push(coordinates[index]);
    expandedPositions.push(index);
    (insertedBySegment.get(index) || []).forEach((boundary) => {
      expandedRefs.push(boundary.nodeRef);
      expandedCoordinates.push(boundary.coordinate);
      expandedPositions.push(boundary.position);
    });
  }

  const splitIndexes = boundaries
    .map((boundary) => expandedPositions.findIndex((position) => Math.abs(position - boundary.position) < options.nodeSnapFraction))
    .filter((index) => index > 0 && index < expandedRefs.length - 1)
    .sort((a, b) => a - b);
  const uniqueSplitIndexes = [...new Set(splitIndexes)];
  const sectionEnds = [...uniqueSplitIndexes, expandedRefs.length - 1];
  let startIndex = 0;
  const baseTags = segment.tags && typeof segment.tags === "object" ? { ...segment.tags } : {};
  const tagStrategy = resolveTactileTagStrategy(segment, options.tactileValue);
  const existingTactileValue = Object.keys(tagStrategy.tags).find((key) =>
    String(baseTags[key] || "").toLowerCase() === String(tagStrategy.tags[key]).toLowerCase());
  if (existingTactileValue) {
    const error = new Error("tactile_tag_already_present");
    error.wayId = wayId;
    error.tagKey = existingTactileValue;
    throw error;
  }
  const sections = sectionEnds.map((endIndex) => {
    const refs = expandedRefs.slice(startIndex, endIndex + 1);
    const coords = expandedCoordinates.slice(startIndex, endIndex + 1);
    const startPosition = expandedPositions[startIndex];
    const endPosition = expandedPositions[endIndex];
    const midpoint = (startPosition + endPosition) / 2;
    const tactile = ranges.some((range) => midpoint > range.low && midpoint < range.high);
    startIndex = endIndex;
    return { refs, coordinates: coords, tactile, tags: tactile ? { ...baseTags, ...tagStrategy.tags } : { ...baseTags } };
  }).filter((section) => section.refs.length >= 2);

  const operations = boundaries.filter((boundary) => boundary.kind === "projection").map((boundary) => ({
    elementType: "node",
    action: "create",
    osmId: null,
    version: null,
    before: null,
    after: { temporaryId: boundary.nodeRef, lat: boundary.coordinate[1], lng: boundary.coordinate[0], tags: {} },
  }));
  const relationRefs = [];
  sections.forEach((section, index) => {
    if (index === 0) {
      relationRefs.push(wayId);
      operations.push({
        elementType: "way", action: "modify", osmId: wayId, version,
        before: { nodes, coordinates, tags: baseTags },
        after: { nodes: section.refs, coordinates: section.coordinates, tags: section.tags, tactileSection: section.tactile },
      });
    } else {
      counters.way += 1;
      const temporaryId = `new-way-${counters.way}`;
      relationRefs.push(temporaryId);
      operations.push({
        elementType: "way", action: "create", osmId: null, version: null, before: null,
        after: { temporaryId, nodes: section.refs, coordinates: section.coordinates, tags: section.tags, tactileSection: section.tactile, splitFromWayId: wayId },
      });
    }
  });
  return { wayId, version, from, to, ranges, sections, relationRefs, operations, tagStrategy };
}

function mergeRepeatedWaySegments(segments) {
  const grouped = new Map();
  segments.forEach((segment) => {
    const key = String(segment && segment.wayId);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...segment, ranges: [{ from: segment.from, to: segment.to }] });
      return;
    }
    const comparable = (value) => JSON.stringify(value == null ? null : value);
    if (Number(existing.wayVersion) !== Number(segment.wayVersion) ||
        comparable(existing.nodes) !== comparable(segment.nodes) ||
        comparable(existing.fullCoordinates) !== comparable(segment.fullCoordinates) ||
        comparable(existing.tags || {}) !== comparable(segment.tags || {}) ||
        String(existing.side || existing.tactileSide || "") !== String(segment.side || segment.tactileSide || "")) {
      throw new Error("inconsistent_duplicate_way");
    }
    existing.ranges.push({ from: segment.from, to: segment.to });
    const relationById = new Map((existing.relations || []).map((relation) => [Number(relation.id), relation]));
    (segment.relations || []).forEach((relation) => relationById.set(Number(relation.id), relation));
    existing.relations = [...relationById.values()];
  });
  return [...grouped.values()];
}

function normalizeRelations(segments) {
  const relations = new Map();
  segments.forEach((segment) => {
    (Array.isArray(segment.relations) ? segment.relations : []).forEach((relation) => {
      const id = Number(relation && relation.id);
      const version = Number(relation && relation.version);
      const members = Array.isArray(relation && relation.members) ? relation.members.map((member) => ({
        type: String(member && member.type || ""),
        ref: Number(member && member.ref),
        role: String(member && member.role || ""),
      })) : [];
      if (!Number.isSafeInteger(id) || id <= 0 || !Number.isInteger(version) || version <= 0 ||
          members.some((member) => !["node", "way", "relation"].includes(member.type) || !Number.isSafeInteger(member.ref) || member.ref <= 0)) {
        throw new Error("invalid_relation");
      }
      const normalized = { id, version, members, tags: relation.tags && typeof relation.tags === "object" ? { ...relation.tags } : {} };
      const existing = relations.get(id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(normalized)) throw new Error("inconsistent_relation");
      relations.set(id, normalized);
    });
  });
  return [...relations.values()];
}

function planRelationUpdates(relations, ways) {
  const replacements = new Map(ways.filter((way) => way.relationRefs.length > 1).map((way) => [way.wayId, way.relationRefs]));
  return relations.flatMap((relation) => {
    let changed = false;
    const members = relation.members.flatMap((member) => {
      const refs = member.type === "way" ? replacements.get(member.ref) : null;
      if (!refs) return [member];
      changed = true;
      const orderedRefs = member.role === "backward" ? [...refs].reverse() : refs;
      return orderedRefs.map((ref) => ({ ...member, ref }));
    });
    if (!changed) return [];
    return [{
      elementType: "relation",
      action: "modify",
      osmId: relation.id,
      version: relation.version,
      before: { members: relation.members, tags: relation.tags },
      after: { members, tags: relation.tags },
    }];
  });
}

function createSplitPlan(input, options = {}) {
  const segments = Array.isArray(input && input.segments) ? input.segments : [];
  if (!segments.length || segments.length > 100) throw new Error("invalid_segments");
  const mergedSegments = mergeRepeatedWaySegments(segments);
  const settings = {
    tactileValue: String(options.tactileValue || "yes"),
    nodeSnapFraction: Number(options.nodeSnapFraction) || DEFAULT_NODE_SNAP_FRACTION,
  };
  const counters = { node: 0, way: 0 };
  const ways = mergedSegments.map((segment) => planWay(segment, counters, settings));
  const relationOperations = planRelationUpdates(normalizeRelations(mergedSegments), ways);
  const operations = [...ways.flatMap((way) => way.operations), ...relationOperations];
  return {
    kind: "osm_split_dry_run",
    osmSent: false,
    tagStrategies: ways.map((way) => ({ wayId: way.wayId, ...way.tagStrategy })),
    ways,
    operations,
    summary: {
      sourceWays: ways.length,
      createdNodes: counters.node,
      createdWays: counters.way,
      modifiedWays: ways.length,
      modifiedRelations: relationOperations.length,
      operationCount: operations.length,
    },
  };
}

module.exports = { createSplitPlan, mergeRepeatedWaySegments, normalizeBoundary, normalizeRelations, planRelationUpdates, resolveTactileTagStrategy };
