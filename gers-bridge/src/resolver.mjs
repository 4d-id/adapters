// Resolver interfaces.
//
// Two capabilities, split deliberately:
//
//   ResolverReader  lookupAlias() — ask whether an external identifier already
//                   maps to a 4D-ID. Read-only, always.
//   AtomicWriter    apply()       — durably record mints and edges, atomically
//                   and idempotently.
//
// A reader never writes. The HTTP reader in this file is read-only by
// construction and refuses to call `/ingest` even if asked; see the guard
// below for why that refusal is enforced rather than documented.
//
// The lookup contract has one subtlety that the whole planner leans on:
//
//     `{ ok: false }` (lookup failed) is NOT `{ ok: true, matches: [] }` (no match).
//
// A failed lookup means we do not know. The planner turns that into `blocked`,
// never into `mint`. A bridge that mints on a timed-out lookup will duplicate
// every identity it already had.

/**
 * @typedef {object} LookupResult
 * @property {boolean} ok        false means the lookup itself did not complete
 * @property {Array<{id: string, registry: string, external_id: string}>} matches
 * @property {string} [reason]   why the lookup failed, when ok is false
 */

/**
 * In-memory resolver reader over a fixed alias table. Useful for tests, dry
 * runs, and bridging against an exported alias snapshot.
 *
 * @param {Array<{id: string, registry: string, external_id: string}>} aliases
 * @param {{ failOn?: (q: object) => string|null }} [opts] inject lookup failures
 */
export function createMemoryResolverReader(aliases = [], { failOn = () => null } = {}) {
  const byKey = new Map();
  for (const a of aliases) {
    const key = aliasKey(a.registry, a.external_id);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ id: a.id, registry: a.registry, external_id: a.external_id });
  }
  return {
    kind: "memory",
    readOnly: true,
    async lookupAlias({ registry, external_id }) {
      const failure = failOn({ registry, external_id });
      if (failure) return { ok: false, matches: [], reason: failure };
      const hits = byKey.get(aliasKey(registry, external_id)) ?? [];
      return { ok: true, matches: hits.map((h) => ({ ...h })) };
    },
  };
}

export function aliasKey(registry, externalId) {
  return `${String(registry)}\u0000${String(externalId)}`;
}

/**
 * Read-only HTTP resolver reader.
 *
 * This adapter talks to a running 4D-ID reference resolver over its read
 * endpoints only. It is structurally incapable of writing:
 *
 *   * the only endpoint it builds is `GET /resolve`;
 *   * every request passes through `assertReadOnly`, which throws on any
 *     non-GET method and on any path that touches a known write endpoint;
 *   * `apply()` exists solely to refuse, loudly, with a message that points the
 *     caller at a real writer.
 *
 * The refusal is enforced rather than merely documented because "the adapter
 * only does reads" is the kind of claim that quietly stops being true.
 */
export function createHttpResolverReader(baseUrl, { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  if (!baseUrl) throw new Error("createHttpResolverReader requires a base url");
  const base = String(baseUrl).replace(/\/+$/, "");

  return {
    kind: "http",
    readOnly: true,
    baseUrl: base,

    async lookupAlias({ registry, external_id }) {
      const url = `${base}/resolve?registry=${encodeURIComponent(registry)}&external_id=${encodeURIComponent(external_id)}`;
      assertReadOnly("GET", url);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, { method: "GET", signal: controller.signal });
        if (res.status === 404) {
          // An explicit "no such alias" from a resolver that answered is a real
          // negative, unlike a transport failure.
          return { ok: true, matches: [] };
        }
        if (!res.ok) {
          return { ok: false, matches: [], reason: `resolver returned HTTP ${res.status}` };
        }
        const body = await res.json();
        return { ok: true, matches: extractMatches(body, registry, external_id) };
      } catch (e) {
        // Transport failure. Explicitly NOT a no-match.
        return { ok: false, matches: [], reason: `resolver lookup failed: ${e.message}` };
      } finally {
        clearTimeout(timer);
      }
    },

    async apply() {
      throw new Error(
        "the HTTP resolver adapter is read-only: it will not POST /ingest or any other write. " +
          "Use a durable writer (createJsonFileStore) to record mints, then have an authorized " +
          "operator promote them into a resolver."
      );
    },
  };
}

const WRITE_PATHS = ["/ingest", "/reconcile", "/events", "/merge", "/split"];

/** Throw unless this is a read request to a non-write path. */
export function assertReadOnly(method, url) {
  if (String(method).toUpperCase() !== "GET") {
    throw new Error(`read-only resolver adapter refused a ${method} request to ${url}`);
  }
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    path = String(url);
  }
  for (const w of WRITE_PATHS) {
    if (path === w || path.startsWith(`${w}/`)) {
      throw new Error(`read-only resolver adapter refused to call write endpoint ${path}`);
    }
  }
  return true;
}

function extractMatches(body, registry, externalId) {
  if (!body) return [];
  const out = [];
  const push = (v) => {
    if (typeof v === "string") out.push({ id: v, registry, external_id: externalId });
    else if (v && typeof v === "object" && typeof v.id === "string") {
      out.push({ id: v.id, registry, external_id: externalId });
    }
  };
  if (Array.isArray(body)) body.forEach(push);
  else if (Array.isArray(body.matches)) body.matches.forEach(push);
  else if (Array.isArray(body.results)) body.results.forEach(push);
  else if (Array.isArray(body.entities)) body.entities.forEach(push);
  else if (typeof body.id === "string") push(body);
  return out;
}
