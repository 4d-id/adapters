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
import { validateHomeToken } from "./home-token.mjs";

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
 * The bridge mints the non-spatial `id` variant on purpose. A GERS registry row
 * and a bridge file give us an identifier correspondence, not a georeferenced
 * pose. We have no grounding, so we emit no cell, no vertical reference and no
 * pose.
 *
 * Per 4D-ID 2.4 /req/core/genesis-privacy this function enforces:
 *
 *   * the home token carries >=128 bits from a documented CSPRNG and encodes no
 *     place, person, or time (validated in home-token.mjs);
 *   * the descriptor is a **UUIDv4** — UUIDv7 is refused, because its timestamp
 *     would encode mint time, which this mode exists to avoid;
 *   * no vertical reference and no genesis marker are ever appended.
 *
 * @param {object}   opts
 * @param {string}   opts.homeToken  an opaque, validated non-spatial home token
 * @param {Function} [opts.uuid]     injectable UUIDv4 source (tests pass a fixed one)
 */
export function mint4did({ homeToken, uuid = randomUUID } = {}) {
  const check = validateHomeToken(homeToken);
  if (!check.ok) {
    throw new Error(
      `invalid non-spatial home token: ${check.reason} ` +
        `(see 4D-ID 2.4 /req/core/genesis-privacy; generate one with generateHomeToken())`
    );
  }

  const u = uuid();
  const syntax = classifyGersSyntax(u);
  if (!syntax.wellFormed) {
    throw new Error(`uuid source did not return a UUID: ${JSON.stringify(u)}`);
  }
  if (syntax.version !== 4) {
    throw new Error(
      `descriptor must be a UUIDv4, got UUIDv${syntax.version}: the id variant forbids UUIDv7 ` +
        `because its embedded timestamp would encode mint time ` +
        `(4D-ID 2.4 /req/core/genesis-privacy)`
    );
  }

  // No ";v=" and no trailing ":<genesis>" — both are forbidden in this mode.
  return `4did:id:${homeToken}:${uuidToBase64Url(syntax.normalized)}`;
}

// Mirrors schemas/common.json: ^4did:id:[A-Za-z0-9.-]{1,64}:[A-Za-z0-9_-]{22,86}$
// We mint the tighter opaque-token form, so validation below is stricter still.
export const FOURDID_ID_RE = /^4did:id:[A-Za-z0-9]{22,64}:[A-Za-z0-9_-]{22,86}$/;

/**
 * True when `value` is a well-formed non-spatial 4D-ID whose home token meets
 * the entropy and opacity rules, and which carries no vref or genesis marker.
 */
export function isNonSpatial4did(value) {
  if (typeof value !== "string" || !FOURDID_ID_RE.test(value)) return false;
  if (value.includes(";v=")) return false; // vertical reference forbidden
  const parts = value.split(":");
  if (parts.length !== 4) return false; // a 5th part would be a genesis marker
  return validateHomeToken(parts[2]).ok;
}

/** Decompose a non-spatial 4D-ID, or return null if it is not one. */
export function parseNonSpatial4did(value) {
  if (!isNonSpatial4did(value)) return null;
  const [, variant, homeToken, descriptor] = value.split(":");
  return { variant, home_token: homeToken, descriptor };
}
