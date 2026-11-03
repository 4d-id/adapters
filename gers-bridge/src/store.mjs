// A reference-only durable JSON store.
//
// Scope, stated plainly: this is a single-host, single-file store meant for
// reference runs, fixtures, and small bridges. It is NOT a database and this
// package does not claim it is production-hardened. What it does guarantee, on
// a POSIX filesystem on one machine:
//
//   * **Mutual exclusion** via an atomic lock *directory*. `mkdir` either
//     creates the directory or fails; there is no check-then-create window, which
//     is exactly the race a lock *file* opened with O_CREAT|O_EXCL also avoids
//     but which naive `existsSync` + `writeFile` does not.
//   * **Atomic publication** via write-to-temp + `rename`. `rename` within a
//     directory is atomic, so a reader either sees the whole previous state or
//     the whole next one, never a half-written file. A crash mid-write leaves
//     the temp file as garbage and the real file intact.
//   * **Idempotent operations.** Every `apply` carries an `operation_id`. The
//     recorded result for that id is returned verbatim on replay, so reruns are
//     no-ops rather than duplicate mints.
//   * **Alias uniqueness.** One (registry, external_id) pair binds to exactly
//     one 4D-ID. Two concurrent callers racing to mint the same alias produce
//     one mint and one reuse, because the binding check happens inside the lock.
//
// Not guaranteed: durability across power loss without fsync of the directory,
// correctness over NFS or other filesystems with weak rename/mkdir semantics,
// or multi-host coordination.

import { mkdir, rmdir, readFile, writeFile, rename, unlink, stat } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { randomUUID } from "node:crypto";

const STORE_VERSION = 1;

function emptyState() {
  return {
    store_version: STORE_VERSION,
    reference_only: true,
    entities: {},
    aliases: {},
    edges: [],
    operations: {},
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Open (or lazily create) a durable JSON store at `path`.
 *
 * @param {string} path
 * @param {{ lockTimeoutMs?: number, staleLockMs?: number, retryMs?: number }} [opts]
 */
export function createJsonFileStore(path, { lockTimeoutMs = 10_000, staleLockMs = 30_000, retryMs = 5 } = {}) {
  const lockDir = `${path}.lock`;
  const lockInfo = join(lockDir, "owner.json");

  async function acquireLock() {
    const deadline = Date.now() + lockTimeoutMs;
    for (;;) {
      try {
        // mkdir is atomic: it succeeds for exactly one caller.
        await mkdir(lockDir);
        await writeFile(lockInfo, JSON.stringify({ pid: process.pid, at: Date.now() }), "utf8");
        return;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        // Someone holds it. Break it only if it is provably stale.
        try {
          const s = await stat(lockDir);
          if (Date.now() - s.mtimeMs > staleLockMs) {
            await releaseLock().catch(() => {});
            continue;
          }
        } catch {
          // Lock vanished between EEXIST and stat; just retry.
        }
        if (Date.now() > deadline) {
          throw new Error(`timed out after ${lockTimeoutMs}ms waiting for store lock at ${lockDir}`);
        }
        await sleep(retryMs);
      }
    }
  }

  async function releaseLock() {
    await unlink(lockInfo).catch(() => {});
    await rmdir(lockDir).catch(() => {});
  }

  async function readState() {
    try {
      const text = await readFile(path, "utf8");
      const parsed = JSON.parse(text);
      return { ...emptyState(), ...parsed };
    } catch (e) {
      if (e.code === "ENOENT") return emptyState();
      throw new Error(`store at ${path} is unreadable: ${e.message}`);
    }
  }

  async function writeState(state) {
    const dir = dirname(path);
    await mkdir(dir, { recursive: true });
    // Unique temp name so a crashed run cannot collide with a live one.
    const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
    // Deterministic key order keeps the on-disk file diffable.
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tmp, path); // atomic publication
  }

  /** Run `fn(state)` under the lock and atomically publish whatever it returns. */
  async function transact(fn) {
    await acquireLock();
    try {
      const state = await readState();
      const { next, result } = await fn(state);
      if (next) await writeState(next);
      return result;
    } finally {
      await releaseLock();
    }
  }

  return {
    path,
    lockDir,
    readOnly: false,

    async read() {
      return readState();
    },

    /**
     * Apply a batch of mints and edges atomically and idempotently.
     *
     * @param {object} op
     * @param {string} op.operation_id  replaying this id returns the first result
     * @param {Array<object>} [op.mints] each { local_id, id, aliases: [{registry, external_id}], record }
     * @param {Array<object>} [op.edges] typed bridge-sidecar edges
     */
    async apply({ operation_id, mints = [], edges = [] }) {
      if (!operation_id) throw new Error("apply requires an operation_id");

      return transact(async (state) => {
        // --- idempotence -------------------------------------------------
        const prior = state.operations[operation_id];
        if (prior) {
          return { next: null, result: { ...prior, replayed: true } };
        }

        const applied = [];
        const next = {
          ...state,
          entities: { ...state.entities },
          aliases: { ...state.aliases },
          edges: [...state.edges],
          operations: { ...state.operations },
        };

        for (const mint of mints) {
          const aliases = mint.aliases ?? [];

          // --- alias uniqueness ----------------------------------------
          // Checked inside the lock, so a concurrent racer that already bound
          // this alias wins and we reuse its id instead of minting a second.
          let boundTo = null;
          let boundVia = null;
          for (const a of aliases) {
            const key = `${a.registry}\u0000${a.external_id}`;
            const existing = next.aliases[key];
            if (existing) {
              boundTo = existing;
              boundVia = key;
              break;
            }
          }

          if (boundTo) {
            applied.push({
              local_id: mint.local_id,
              id: boundTo,
              outcome: "reused",
              reason: `alias ${boundVia.replace("\u0000", ":")} already bound to ${boundTo}`,
            });
            continue;
          }

          if (next.entities[mint.id]) {
            applied.push({
              local_id: mint.local_id,
              id: mint.id,
              outcome: "reused",
              reason: "identifier already present in store",
            });
            continue;
          }

          next.entities[mint.id] = mint.record ?? { id: mint.id };
          for (const a of aliases) {
            next.aliases[`${a.registry}\u0000${a.external_id}`] = mint.id;
          }
          applied.push({ local_id: mint.local_id, id: mint.id, outcome: "minted", reason: null });
        }

        // Edges are deduplicated on their semantic key so a rerun that slips
        // past the operation check still cannot double-write an edge.
        const edgeKeys = new Set(next.edges.map(edgeKey));
        const appliedEdges = [];
        for (const e of edges) {
          const k = edgeKey(e);
          if (edgeKeys.has(k)) continue;
          edgeKeys.add(k);
          next.edges.push(e);
          appliedEdges.push(e);
        }

        const result = {
          operation_id,
          applied,
          edges_added: appliedEdges.length,
          replayed: false,
        };
        next.operations[operation_id] = result;
        return { next, result };
      });
    },
  };
}

export function edgeKey(e) {
  return [e.type, e.from, e.to, e.registry ?? "", e.external_id ?? ""].join("\u0000");
}
