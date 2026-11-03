#!/usr/bin/env node
// 4did-gers — CLI for the reference-only GERS bridge.
//
// Every command writes machine-readable JSON to stdout and human notes to
// stderr, so the output can be piped without stripping anything.

import { readFileSync, writeFileSync } from "node:fs";
import { parseManifest, parseInput, normalizeRecords } from "./input.mjs";
import { createRegistryVerifier, createUnknownVerifier } from "./membership.mjs";
import { generateHomeToken, homeTokenProvenance } from "./home-token.mjs";
import { createMemoryResolverReader, createHttpResolverReader } from "./resolver.mjs";
import { createJsonFileStore } from "./store.mjs";
import { planImport } from "./plan.mjs";
import { applyPlan, inspectPlan, exportBridge, serializeExport } from "./apply.mjs";

const USAGE = `4did-gers — reference-only Overture GERS <-> 4D-ID bridge

Usage:
  4did-gers home-token [--json]
  4did-gers plan    --input=<file> --manifest=<file> [--capture=<file>]
                    [--resolver=<url> | --aliases=<file>] [--format=auto|geojson|jsonl]
                    [--out=<file>]
  4did-gers apply   --plan=<file> --store=<file> --reference-only
  4did-gers inspect --plan=<file> [--store=<file>]
  4did-gers export  --plan=<file> [--store=<file>] [--out=<file>]

Notes:
  home-token mints an opaque 128-bit home token for a manifest. It encodes no
    place, person, or time (4D-ID 2.4 /req/core/genesis-privacy).
  --resolver is READ-ONLY. This CLI never posts to /ingest.
  apply requires --reference-only: there is no authoritative write mode.
  Without --capture, every membership answer is "unknown" and nothing mints.
`;

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith("--"));
const flag = (name) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf("=");
  return eq === -1 ? true : hit.slice(eq + 1);
};
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const emit = (doc, outPath) => {
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  if (outPath && typeof outPath === "string") {
    writeFileSync(outPath, text, "utf8");
    process.stderr.write(`wrote ${outPath}\n`);
  } else {
    process.stdout.write(text);
  }
};
const die = (msg, code = 2) => {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
};

async function buildPlan() {
  const inputPath = flag("input");
  const manifestPath = flag("manifest");
  if (!inputPath || !manifestPath) die("plan requires --input and --manifest\n\n" + USAGE);

  const manifest = parseManifest(readJson(manifestPath));
  const { features, format } = parseInput(readFileSync(inputPath, "utf8"), {
    format: flag("format") ?? "auto",
  });
  const records = normalizeRecords(features, manifest);

  const capturePath = flag("capture");
  const verifier = capturePath
    ? createRegistryVerifier(readJson(capturePath))
    : createUnknownVerifier();
  if (!capturePath) {
    process.stderr.write(
      "no --capture supplied: all membership answers will be \"unknown\" and no record will mint\n"
    );
  }

  const resolverUrl = flag("resolver");
  const aliasPath = flag("aliases");
  let reader;
  if (resolverUrl && typeof resolverUrl === "string") {
    reader = createHttpResolverReader(resolverUrl);
    process.stderr.write(`using read-only HTTP resolver at ${resolverUrl}\n`);
  } else if (aliasPath && typeof aliasPath === "string") {
    reader = createMemoryResolverReader(readJson(aliasPath));
  } else {
    reader = createMemoryResolverReader([]);
    process.stderr.write("no resolver configured: treating every alias lookup as a clean no-match\n");
  }

  const plan = await planImport(records, manifest, { reader, verifier });
  process.stderr.write(
    `parsed ${features.length} feature(s) as ${format}; ` +
      `reuse=${plan.counts.reuse} mint=${plan.counts.mint} ` +
      `review=${plan.counts.review} blocked=${plan.counts.blocked}\n`
  );
  return plan;
}

// Operator errors (a bad manifest, an unreadable file) deserve a clear message
// and a non-zero exit, not a stack trace.
try {
  await main();
} catch (e) {
  process.stderr.write(`${e && e.message ? e.message : e}\n`);
  process.exit(2);
}

async function main() {
switch (cmd) {
  case "home-token": {
    const token = generateHomeToken();
    if (flag("json")) {
      emit(homeTokenProvenance(token, { generated: true }), flag("out"));
    } else {
      process.stdout.write(`${token}\n`);
      process.stderr.write(
        "128 bits from the OpenSSL CSPRNG; encodes no place, person, or time.\n" +
          "Put this in your manifest's \"home_token\" field.\n"
      );
    }
    break;
  }

  case "plan": {
    emit(await buildPlan(), flag("out"));
    break;
  }

  case "apply": {
    const planPath = flag("plan");
    const storePath = flag("store");
    if (!planPath || !storePath) die("apply requires --plan and --store\n\n" + USAGE);
    if (!flag("reference-only")) {
      die(
        "apply requires --reference-only.\n" +
          "This bridge only writes to a local reference store; it does not write authoritative\n" +
          "identity state and will not post to a resolver."
      );
    }
    const plan = readJson(planPath);
    const store = createJsonFileStore(storePath);
    const result = await applyPlan(plan, store, { referenceOnly: true });
    process.stderr.write(
      `${result.replayed ? "replayed" : "applied"} operation ${result.operation_id}: ` +
        `${result.applied.length} entity op(s), ${result.edges_added} edge(s) added\n`
    );
    emit(result, flag("out"));
    break;
  }

  case "inspect": {
    const planPath = flag("plan");
    if (!planPath) die("inspect requires --plan\n\n" + USAGE);
    const storePath = flag("store");
    const storeState = storePath ? await createJsonFileStore(storePath).read() : null;
    emit(inspectPlan(readJson(planPath), storeState), flag("out"));
    break;
  }

  case "export": {
    const planPath = flag("plan");
    if (!planPath) die("export requires --plan\n\n" + USAGE);
    const storePath = flag("store");
    const storeState = storePath ? await createJsonFileStore(storePath).read() : null;
    const doc = exportBridge(readJson(planPath), storeState);
    const outPath = flag("out");
    if (outPath && typeof outPath === "string") {
      writeFileSync(outPath, serializeExport(doc), "utf8");
      process.stderr.write(`wrote ${outPath}\n`);
    } else {
      process.stdout.write(serializeExport(doc));
    }
    break;
  }

  default:
    process.stderr.write(USAGE);
    process.exit(cmd ? 2 : 0);
}
}
