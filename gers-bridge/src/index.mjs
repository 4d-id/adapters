// @4d-id/gers-bridge — public API.
//
// A reference-only bridge between Overture GERS identifiers and 4D-IDs. It
// resolves before it mints, verifies membership against a registry capture
// instead of guessing from identifier syntax, keeps source-binding trust
// separate from membership, and records what it did in typed sidecar edges.
//
// It performs no grounding. See README "Grounding boundary".

export {
  classifyGersSyntax,
  normalizeGersId,
  mint4did,
  isNonSpatial4did,
  parseNonSpatial4did,
  FOURDID_ID_RE,
} from "./identity.mjs";
export {
  generateHomeToken,
  validateHomeToken,
  isValidHomeToken,
  homeTokenProvenance,
  maxEntropyBits,
  ENTROPY_SOURCE,
  HOME_TOKEN_BYTES,
  MIN_HOME_TOKEN_BITS,
} from "./home-token.mjs";
export { MEMBERSHIP, createRegistryVerifier, createUnknownVerifier } from "./membership.mjs";
export { BINDING, bindingRank, meetsBindingTrust, classifyBinding } from "./trust.mjs";
export { parseManifest, parseInput, normalizeRecords } from "./input.mjs";
export { EDGE, edgeSemantics, identifiedAsEdge, describesEdge, containsEdge, representsEdge } from "./edges.mjs";
export { OUTCOME, planImport } from "./plan.mjs";
export { createMemoryResolverReader, createHttpResolverReader, assertReadOnly, aliasKey } from "./resolver.mjs";
export { createJsonFileStore, edgeKey } from "./store.mjs";
export { applyPlan, planOperationId, inspectPlan, exportBridge, serializeExport } from "./apply.mjs";
