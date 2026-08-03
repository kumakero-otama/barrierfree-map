function mapTemporaryReferences(value, temporaryIds, diffResult) {
  const assigned = new Map();
  Object.entries(temporaryIds || {}).forEach(([name, negativeId]) => {
    const match = (diffResult || []).find((item) => Number(item.oldId) === Number(negativeId));
    if (match) assigned.set(name, match.newId);
  });
  const mapRef = (ref) => assigned.get(String(ref)) || ref;
  if (!value || typeof value !== "object") return value;
  const copy = JSON.parse(JSON.stringify(value));
  if (Array.isArray(copy.nodes)) copy.nodes = copy.nodes.map(mapRef);
  if (Array.isArray(copy.members)) copy.members = copy.members.map((member) => ({ ...member, ref: mapRef(member.ref) }));
  return copy;
}

function findApplied(operation, temporaryIds, diffResult) {
  if (operation.action === "create") {
    const negativeId = temporaryIds && temporaryIds[operation.after && operation.after.temporaryId];
    return (diffResult || []).find((item) => item.elementType === operation.elementType && Number(item.oldId) === Number(negativeId));
  }
  return (diffResult || []).find((item) => item.elementType === operation.elementType && Number(item.oldId) === Number(operation.osmId));
}

function createExecutableRevert(sourceOperations, executionResult) {
  if (!executionResult || !Array.isArray(executionResult.diffResult)) throw new Error("missing_execution_result");
  return [...sourceOperations].reverse().map((operation) => {
    const applied = findApplied(operation, executionResult.temporaryIds || {}, executionResult.diffResult);
    if (!applied || !Number.isSafeInteger(Number(applied.newId)) || !Number.isInteger(Number(applied.newVersion))) {
      throw new Error("incomplete_osm_diff_result");
    }
    const appliedAfter = mapTemporaryReferences(operation.after, executionResult.temporaryIds, executionResult.diffResult);
    const originalBefore = mapTemporaryReferences(operation.before, executionResult.temporaryIds, executionResult.diffResult);
    if (operation.action === "create") {
      return { elementType: operation.elementType, action: "delete", osmId: Number(applied.newId), version: Number(applied.newVersion), before: appliedAfter, after: null };
    }
    return {
      elementType: operation.elementType,
      action: "modify",
      osmId: Number(applied.newId),
      version: Number(applied.newVersion),
      before: appliedAfter,
      after: originalBefore,
    };
  });
}

module.exports = { createExecutableRevert, mapTemporaryReferences };
