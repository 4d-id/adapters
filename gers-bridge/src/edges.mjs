// Typed bridge-sidecar edges.
//
// These live in a sidecar, not in the resolver's authoritative graph, because
// this bridge is not an authority. They record what a GERS correspondence does
// and does not mean. The four types are distinct and are not substitutes:
//
//   identified_as  "this entity is known in registry R as X". An identifier
//                  correspondence. Carries no geometry and no pose.
//
//   describes      "this GERS feature carries attributes about this entity".
//                  Weaker than identified_as: useful when the binding is good
//                  enough to attach attributes but not good enough to claim the
//                  two records are the same thing.
//
//   contains       parentage ONLY. A tree edge from parent to child. It is not
//                  a general "overlaps"/"within" spatial predicate, and this
//                  bridge cannot compute one — it has no grounding. Emitted
//                  only from an explicit parent_local_id field.
//
//   represents     "this entity is a representation of that one" — a model, a
//                  scan, a tileset. A representation attaches geometry; it does
//                  not derive pose. The bridge emits this only when the operator
//                  declares it; it never infers one.

export const EDGE = Object.freeze({
  IDENTIFIED_AS: "identified_as",
  DESCRIBES: "describes",
  CONTAINS: "contains",
  REPRESENTS: "represents",
});

const SEMANTICS = Object.freeze({
  [EDGE.IDENTIFIED_AS]: {
    meaning: "entity is known in an external registry under this identifier",
    implies_geometry: false,
    implies_pose: false,
    is_parentage: false,
  },
  [EDGE.DESCRIBES]: {
    meaning: "external feature carries attributes about this entity, without asserting sameness",
    implies_geometry: false,
    implies_pose: false,
    is_parentage: false,
  },
  [EDGE.CONTAINS]: {
    meaning: "parentage in the containment tree; not a spatial overlap predicate",
    implies_geometry: false,
    implies_pose: false,
    is_parentage: true,
  },
  [EDGE.REPRESENTS]: {
    meaning: "entity is a representation (model/scan/tileset) of the target entity",
    implies_geometry: true,
    implies_pose: false,
    is_parentage: false,
  },
});

/** Static semantics for an edge type. */
export function edgeSemantics(type) {
  return SEMANTICS[type] ?? null;
}

/**
 * Build an `identified_as` edge from a 4D-ID to an external registry identifier.
 * `membership` and `binding` travel with the edge so a consumer can see on what
 * evidence it was written.
 */
export function identifiedAsEdge({ from, registry, external_id, membership, binding, confidence }) {
  return {
    type: EDGE.IDENTIFIED_AS,
    from,
    to: null,
    registry,
    external_id,
    membership: membership ?? null,
    binding: binding ?? null,
    confidence: confidence ?? null,
    implies_geometry: false,
    implies_pose: false,
  };
}

/** Build a `describes` edge: attributes attach, sameness is not claimed. */
export function describesEdge({ from, registry, external_id, membership, binding, confidence }) {
  return {
    type: EDGE.DESCRIBES,
    from,
    to: null,
    registry,
    external_id,
    membership: membership ?? null,
    binding: binding ?? null,
    confidence: confidence ?? null,
    implies_geometry: false,
    implies_pose: false,
  };
}

/**
 * Build a `contains` parentage edge.
 *
 * Rejects self-parentage. Callers must only pass pairs derived from an explicit
 * declared parent field — never from geometry, which this bridge does not read.
 */
export function containsEdge({ from, to }) {
  if (!from || !to) throw new Error("contains edge requires both from (parent) and to (child)");
  if (from === to) throw new Error("contains edge cannot be self-referential");
  return {
    type: EDGE.CONTAINS,
    from,
    to,
    registry: null,
    external_id: null,
    membership: null,
    binding: null,
    confidence: null,
    parentage_only: true,
    implies_geometry: false,
    implies_pose: false,
  };
}

/** Build a `represents` edge. Only ever from an explicit operator declaration. */
export function representsEdge({ from, to, kind, declared_by }) {
  if (!from || !to) throw new Error("represents edge requires both from and to");
  if (!declared_by) {
    throw new Error(
      "represents edge requires declared_by: the bridge never infers a representation relationship"
    );
  }
  return {
    type: EDGE.REPRESENTS,
    from,
    to,
    registry: null,
    external_id: null,
    kind: kind ?? null,
    declared_by,
    membership: null,
    binding: null,
    confidence: null,
    implies_geometry: true,
    implies_pose: false,
  };
}
