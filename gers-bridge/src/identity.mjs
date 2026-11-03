// Identifier handling for the GERS bridge.
//
// Two identifier systems meet here and they are deliberately kept apart:
//
//   * A **GERS ID** is a UUID assigned by Overture to a feature that is in the
//     Overture reference map. Since the June 2025 release the format is UUIDv4.
//     Because the format is a plain UUIDv4, *the format carries no information
//     about membership*. Any random UUIDv4 is syntactically a well-formed GERS
//     ID and almost certainly not one. Membership is a fact about a registry
//     capture, never a fact about a string. See `membership.mjs`.
//
//   * A **4D-ID** is minted by us. This bridge mints only the non-spatial
//     `4did:id:` form, because a bridge from a tabular registry has no grounding
//     and must not pretend to have one. See `mint4did` below.

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// GERS identifier syntax
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-([1-8])[0-9a-f]{3}-([89ab])[0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Classify the *syntax* of a candidate GERS identifier.
 *
 * This answers "could this string be a GERS ID?" and nothing else. A return of
 * `{ wellFormed: true }` explicitly does NOT mean the identifier is in GERS.
 * Callers that need that must consult a registry capture.
 *
 * @returns {{ wellFormed: boolean, normalized: string|null, version: number|null, reason: string|null }}
 */
export function classifyGersSyntax(value) {
  if (typeof value !== "string") {
    return { wellFormed: false, normalized: null, version: null, reason: "not-a-string" };
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return { wellFormed: false, normalized: null, version: null, reason: "empty" };
  }
  const lowered = trimmed.toLowerCase();
  const m = lowered.match(UUID_RE);
  if (!m) {
    return { wellFormed: false, normalized: null, version: null, reason: "not-a-uuid" };
  }
  return { wellFormed: true, normalized: lowered, version: Number(m[1]), reason: null };
}

/**
 * Normalize a GERS ID for byte-wise comparison, or return null if it is not
 * even syntactically a UUID. Normalization is lowercase; it is not validation
 * of membership.
 */
export function normalizeGersId(value) {
  return classifyGersSyntax(value).normalized;
}

// ---------------------------------------------------------------------------
// 4D-ID minting (non-spatial form only)
// ---------------------------------------------------------------------------

const HOME_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

/** Encode a UUID's 16 bytes as unpadded base64url (22 chars). */
function uuidToBase64Url(uuid) {
  const hex = uuid.replace(/-/g, "");
  const bytes = Buffer.from(hex, "hex");
  return bytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Mint a non-spatial 4D-ID of the form `4did:id:<home-token>:<uuidv4-base64url>`.
 *
 * The bridge mints the non-spatial variant on purpose. A GERS registry row and a
 * bridge file give us an identifier correspondence, not a georeferenced pose. We
 * have no grounding, so we do not emit a cell, a vertical reference, or a pose.
 * Anything that needs grounding must come from a system that actually performed
 * it; see the grounding-boundary note in the README.
 *
 * @param {object}   opts
 * @param {string}   opts.homeToken  the minting home/authority token
 * @param {Function} [opts.uuid]     injectable UUIDv4 source (tests pass a fixed one)
 */
export function mint4did({ homeToken, uuid = randomUUID } = {}) {
  if (!HOME_TOKEN_RE.test(String(homeToken ?? ""))) {
    throw new Error(
      `invalid home token ${JSON.stringify(homeToken)}: expected 1-63 chars of [A-Za-z0-9._-] starting alphanumeric`
    );
  }
  const u = uuid();
  const syntax = classifyGersSyntax(u);
  if (!syntax.wellFormed || syntax.version !== 4) {
    throw new Error(`uuid source did not return a UUIDv4: ${JSON.stringify(u)}`);
  }
  return `4did:id:${homeToken}:${uuidToBase64Url(syntax.normalized)}`;
}

export const FOURDID_ID_RE =
  /^4did:id:[A-Za-z0-9][A-Za-z0-9._-]{0,62}:[A-Za-z0-9_-]{22}$/;

/** True when `value` is a well-formed non-spatial 4D-ID as minted here. */
export function isNonSpatial4did(value) {
  return typeof value === "string" && FOURDID_ID_RE.test(value);
}
