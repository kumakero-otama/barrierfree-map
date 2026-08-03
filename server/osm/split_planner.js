const DEFAULT_NODE_SNAP_FRACTION = 1e-6;

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

function planWay(segment, counters, options) {
  const wayId = Number(segment.wayId);
  const version = Number(segment.wayVersion);
  const nodes = Array.isArray(segment.nodes) ? [...segment.nodes] : [];
  const coordinates = Array.isArray(segment.fullCoordinates) ? segment.fullCoordinates.map((c) => [Number(c[0]), Number(c[1])]) : [];
  if (!Number.isSafeInteger(wayId) || wayId <= 0 || !Number.isInteger(version) || version <= 0) throw new Error("invalid_way_identity");
  if (nodes.length < 2 || nodes.length !== coordinates.length || coordinates.some((c) => !Number.isFinite(c[0]) || !Number.isFinite(c[1]))) {
    throw new Error("invalid_way_geometry");
  }
  const from = normalizeBoundary(segment.from, nodes, coordinates, options.nodeSnapFraction);
  const to = normalizeBoundary(segment.to, nodes, coordinates, options.nodeSnapFraction);
  if (Math.abs(from.position - to.position) < options.nodeSnapFraction) throw new Error("zero_length_tactile_segment");

  const rawBoundaries = [from, to].sort((a, b) => a.position - b.position);
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
  const low = Math.min(from.position, to.position);
  const high = Math.max(from.position, to.position);
  const baseTags = segment.tags && typeof segment.tags === "object" ? { ...segment.tags } : {};
  const sections = sectionEnds.map((endIndex) => {
    const refs = expandedRefs.slice(startIndex, endIndex + 1);
    const coords = expandedCoordinates.slice(startIndex, endIndex + 1);
    const startPosition = expandedPositions[startIndex];
    const endPosition = expandedPositions[endIndex];
    const midpoint = (startPosition + endPosition) / 2;
    const tactile = midpoint > low && midpoint < high;
    startIndex = endIndex;
    return { refs, coordinates: coords, tactile, tags: tactile ? { ...baseTags, tactile_paving: options.tactileValue } : { ...baseTags } };
  }).filter((section) => section.refs.length >= 2);

  const operations = boundaries.filter((boundary) => boundary.kind === "projection").map((boundary) => ({
    elementType: "node",
    action: "create",
    osmId: null,
    version: null,
    before: null,
    after: { temporaryId: boundary.nodeRef, lat: boundary.coordinate[1], lng: boundary.coordinate[0], tags: {} },
  }));
  sections.forEach((section, index) => {
    if (index === 0) {
      operations.push({
        elementType: "way", action: "modify", osmId: wayId, version,
        before: { nodes, coordinates, tags: baseTags },
        after: { nodes: section.refs, coordinates: section.coordinates, tags: section.tags, tactileSection: section.tactile },
      });
    } else {
      counters.way += 1;
      operations.push({
        elementType: "way", action: "create", osmId: null, version: null, before: null,
        after: { temporaryId: `new-way-${counters.way}`, nodes: section.refs, coordinates: section.coordinates, tags: section.tags, tactileSection: section.tactile, splitFromWayId: wayId },
      });
    }
  });
  return { wayId, version, from, to, sections, operations };
}

function createSplitPlan(input, options = {}) {
  const segments = Array.isArray(input && input.segments) ? input.segments : [];
  if (!segments.length || segments.length > 100) throw new Error("invalid_segments");
  const duplicateCheck = new Set();
  segments.forEach((segment) => {
    if (duplicateCheck.has(String(segment.wayId))) throw new Error("duplicate_way_in_route");
    duplicateCheck.add(String(segment.wayId));
  });
  const settings = {
    tactileValue: String(options.tactileValue || "yes"),
    nodeSnapFraction: Number(options.nodeSnapFraction) || DEFAULT_NODE_SNAP_FRACTION,
  };
  const counters = { node: 0, way: 0 };
  const ways = segments.map((segment) => planWay(segment, counters, settings));
  return {
    kind: "osm_split_dry_run",
    osmSent: false,
    tags: { tactile_paving: settings.tactileValue },
    ways,
    operations: ways.flatMap((way) => way.operations),
    summary: {
      sourceWays: ways.length,
      createdNodes: counters.node,
      createdWays: counters.way,
      modifiedWays: ways.length,
      operationCount: ways.reduce((sum, way) => sum + way.operations.length, 0),
    },
  };
}

module.exports = { createSplitPlan, normalizeBoundary };
