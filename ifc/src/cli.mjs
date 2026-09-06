#!/usr/bin/env node
import { importIFC } from "./ifc-adapter.mjs";
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith("--"));
const latA = args.find(a=>a.startsWith("--lat=")); const lngA = args.find(a=>a.startsWith("--lng="));
const post = args.find(a=>a.startsWith("--ingest="));
if (!file) { console.error("usage: 4did-ifc <file.ifc> [--lat=.. --lng=..] [--ingest=<resolver-base-url>]"); process.exit(2); }
const text = readFileSync(file, "utf8");
const { entities, siteLat, siteLng } = importIFC(text, { siteLat: latA?+latA.split("=")[1]:null, siteLng: lngA?+lngA.split("=")[1]:null });
if (post) {
  const base = post.split("=")[1].replace(/\/$/,"");
  let ok=0; for (const e of entities) { try { const r = await fetch(base+"/ingest",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(e)}); if(r.ok) ok++; } catch{} }
  console.error(`ingested ${ok}/${entities.length} entities into ${base}`);
} else {
  console.log(JSON.stringify(entities, null, 2));
}
console.error(`\n${entities.length} entities from ${file}  (site ${siteLat.toFixed?siteLat.toFixed(4):siteLat}, ${siteLng.toFixed?siteLng.toFixed(4):siteLng})`);
