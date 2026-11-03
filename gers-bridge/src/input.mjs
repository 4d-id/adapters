// Input: GeoJSON (Feature / FeatureCollection) and JSONL, driven by an explicit
// import manifest.
//
// The manifest is mandatory and it is explicit on purpose. Field sniffing —
// "this column is called `gers_id` so it must be a GERS ID" — is how a bridge
// starts inventing identity. The operator states which field means what, and we
// read exactly that.

import { BINDING } from "./trust.mjs";
import { MEMBERSHIP } from "./membership.mjs";
import { validateHomeToken } from "./home-token.mjs";

const MANIFEST_VERSION = 1;

/** Read a dotted path out of an object. Returns undefined, never throws. */
function getPath(obj, path) {
  if (obj == null || !path) return undefined;
  let cur = obj;
  for (const seg of String(path).split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * Look up a manifest-declared field on a feature: `properties` first (the
 * GeoJSON convention), then the top-level object (the JSONL convention).
 */
function readField(feature, path) {
  if (!path) return undefined;
  const fromProps = getPath(feature?.properties, path);
  if (fromProps !== undefined) return fromProps;
  return getPath(feature, path);
}

/**
 * Validate and normalize an import manifest.
 *
 * @param {object} raw
 * @returns {object} frozen, normalized manifest
 */
export function parseManifest(raw) {
  if (!raw || typeof raw !== "object") throw new Error("manifest must be an object");
  if (raw.manifest_version !== MANIFEST_VERSION) {
    throw new Error(
      `unsupported manifest_version ${JSON.stringify(raw.manifest_version)}; expected ${MANIFEST_VERSION}`
    );
  }

  const source = raw.source ?? {};
  if (!source.registry) {
    throw new Error("manifest.source.registry is required: name the registry the local ids live in");
  }
  if (!raw.home_token) {
    throw new Error(
      "manifest.home_token is required: non-spatial 4D-IDs are minted under an opaque home token. " +
        "Generate one with `4did-gers home-token` — it must carry at least 128 bits from a CSPRNG " +
        "and encode no place, person, or time (4D-ID 2.4 /req/core/genesis-privacy)."
    );
  }
  const tokenCheck = validateHomeToken(raw.home_token);
  if (!tokenCheck.ok) {
    throw new Error(
      `manifest.home_token is not a valid non-spatial home token: ${tokenCheck.reason}. ` +
        `Generate one with \`4did-gers home-token\`.`
    );
  }

  const fields = raw.fields ?? {};
  if (!fields.local_id) {
    throw new Error("manifest.fields.local_id is required: name the field holding each record's own id");
  }

  const policy = raw.policy ?? {};
  const minBindingTrust = policy.min_binding_trust ?? BINDING.ONBOARDING_SERVICE;
  if (!Object.values(BINDING).includes(minBindingTrust)) {
    throw new Error(`manifest.policy.min_binding_trust ${JSON.stringify(minBindingTrust)} is not a known binding tier`);
  }

  // Which membership outcomes permit minting a fresh 4D-ID. `verified_absent`
  // only, by default: if we do not know whether the feature is in GERS, we do
  // not get to decide it is new.
  const mintOn = policy.mint_on ?? [MEMBERSHIP.ABSENT];
  if (!Array.isArray(mintOn) || mintOn.length === 0) {
    throw new Error("manifest.policy.mint_on must be a non-empty array of membership outcomes");
  }
  for (const o of mintOn) {
    if (!Object.values(MEMBERSHIP).includes(o)) {
      throw new Error(`manifest.policy.mint_on contains unknown membership outcome ${JSON.stringify(o)}`);
    }
  }
  if (mintOn.includes(MEMBERSHIP.INVALID)) {
    throw new Error("manifest.policy.mint_on may not include 'invalid'");
  }

  return Object.freeze({
    manifest_version: MANIFEST_VERSION,
    source: Object.freeze({
      registry: String(source.registry),
      dataset: source.dataset ? String(source.dataset) : null,
      theme: source.theme ? String(source.theme) : null,
    }),
    home_token: String(raw.home_token),
    fields: Object.freeze({
      local_id: String(fields.local_id),
      gers_id: fields.gers_id ? String(fields.gers_id) : null,
      label: fields.label ? String(fields.label) : null,
      parent_local_id: fields.parent_local_id ? String(fields.parent_local_id) : null,
      theme: fields.theme ? String(fields.theme) : null,
    }),
    binding: raw.binding ? Object.freeze({ ...raw.binding }) : null,
    policy: Object.freeze({
      min_binding_trust: minBindingTrust,
      mint_on: Object.freeze([...mintOn]),
      allow_mint: policy.allow_mint !== false,
    }),
  });
}

/**
 * Parse GeoJSON or JSONL text into a flat array of features, preserving order.
 *
 * @param {string} text
 * @param {{ format?: "auto"|"geojson"|"jsonl" }} [opts]
 */
export function parseInput(text, { format = "auto" } = {}) {
  if (typeof text !== "string") throw new Error("input must be a string");
  const trimmed = text.trim();
  if (trimmed === "") return { format: format === "auto" ? "jsonl" : format, features: [] };

  let chosen = format;
  if (chosen === "auto") {
    // A single JSON document starts with `{` or `[` and parses whole. JSONL
    // starts with `{` too, so try whole-document parse first and fall back.
    chosen = "jsonl";
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        JSON.parse(trimmed);
        chosen = "geojson";
      } catch {
        chosen = "jsonl";
      }
    }
  }

  if (chosen === "geojson") {
    let doc;
    try {
      doc = JSON.parse(trimmed);
    } catch (e) {
      throw new Error(`input is not valid JSON: ${e.message}`);
    }
    return { format: "geojson", features: flattenGeoJson(doc) };
  }

  const features = [];
  const lines = trimmed.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    let doc;
    try {
      doc = JSON.parse(line);
    } catch (e) {
      throw new Error(`input line ${i + 1} is not valid JSON: ${e.message}`);
    }
    for (const f of flattenGeoJson(doc)) features.push(f);
  }
  return { format: "jsonl", features };
}

function flattenGeoJson(doc) {
  if (Array.isArray(doc)) return doc.flatMap(flattenGeoJson);
  if (!doc || typeof doc !== "object") throw new Error("input record must be an object");
  if (doc.type === "FeatureCollection") {
    if (!Array.isArray(doc.features)) throw new Error("FeatureCollection.features must be an array");
    return doc.features.flatMap(flattenGeoJson);
  }
  // A bare Feature, or a plain JSONL row. Both are accepted; a plain row simply
  // has no `geometry`.
  return [doc];
}

/**
 * Apply a manifest to parsed features, producing normalized bridge records.
 *
 * Geometry is noted but never used for grounding. This bridge has no grounding
 * capability and emits no pose; see README "Grounding boundary".
 */
export function normalizeRecords(features, manifest) {
  return features.map((feature, index) => {
    const localRaw = readField(feature, manifest.fields.local_id);
    const localId =
      localRaw == null || String(localRaw).trim() === "" ? null : String(localRaw).trim();

    const gersRaw = manifest.fields.gers_id ? readField(feature, manifest.fields.gers_id) : undefined;
    const gersId =
      gersRaw == null || String(gersRaw).trim() === "" ? null : String(gersRaw).trim();

    const labelRaw = manifest.fields.label ? readField(feature, manifest.fields.label) : undefined;
    const parentRaw = manifest.fields.parent_local_id
      ? readField(feature, manifest.fields.parent_local_id)
      : undefined;
    const themeRaw = manifest.fields.theme ? readField(feature, manifest.fields.theme) : undefined;

    // Per-record binding overrides the manifest default; neither invents one.
    const perRecord = readField(feature, "gers_binding");
    const binding =
      perRecord && typeof perRecord === "object"
        ? { ...(manifest.binding ?? {}), ...perRecord }
        : manifest.binding
          ? { ...manifest.binding }
          : null;

    return {
      source_index: index,
      local_id: localId,
      gers_id: gersId,
      gers_binding: gersId ? binding : null,
      label: labelRaw == null ? null : String(labelRaw),
      parent_local_id:
        parentRaw == null || String(parentRaw).trim() === "" ? null : String(parentRaw).trim(),
      theme:
        themeRaw == null || String(themeRaw).trim() === ""
          ? manifest.source.theme
          : String(themeRaw).trim(),
      has_geometry: Boolean(feature?.geometry),
      geometry_type: feature?.geometry?.type ?? null,
    };
  });
}
