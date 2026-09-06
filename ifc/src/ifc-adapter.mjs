// @4d-id/ifc-adapter — import an IFC (STEP) file into 4D-ID entities.
// This is the "translate once at the edge" pattern: an IFC file goes in, a set of
// 4D-States comes out, each anchored, hierarchy preserved, IFC GlobalId attached as
// an identified_as relation, and geometry classes mapped to semantics. It does not
// re-implement IFC geometry; it lifts the spatial structure and identity, which is
// exactly what a shared name needs.
import * as h3 from "h3-js";
import { randomUUID } from "node:crypto";

// --- 4D-ID identifier minting (matches the spec, Part 1 7.2) ---
function descriptor() {
  const u = randomUUID().replace(/-/g, "");
  const bytes = u.match(/.{2}/g).map(h => parseInt(h, 16));
  return Buffer.from(String.fromCharCode(...bytes), "binary").toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
function mint(lat, lng, vref) {
  const cell = h3.latLngToCell(lat, lng, 12);
  return { id: `4did:h3:${cell}${vref?`;v=${vref}`:""}:${descriptor()}`, cell };
}

// --- minimal IFC STEP parser: entity lines "#id=TYPE(args);" ---
function parseStep(text) {
  const ents = new Map();
  // join to one string, strip comments, split on ; at line level
  const body = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /#(\d+)\s*=\s*([A-Z0-9_]+)\s*\(([\s\S]*?)\)\s*;/g;
  let m;
  while ((m = re.exec(body))) {
    ents.set("#"+m[1], { id: "#"+m[1], type: m[2], raw: m[3] });
  }
  return ents;
}

// split IFC argument list at top level (respecting nested parens and quotes)
function splitArgs(raw) {
  const out = []; let depth = 0, cur = "", inStr = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "'" ) { inStr = !inStr; cur += c; continue; }
    if (inStr) { cur += c; continue; }
    if (c === "(") { depth++; cur += c; }
    else if (c === ")") { depth--; cur += c; }
    else if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; }
    else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const str = s => { const m = s && s.match(/^'(.*)'$/); return m ? m[1] : null; };
const refs = s => (s.match(/#\d+/g) || []);

// walk a local placement chain to an approximate (x,y,z) by summing cartesian points
function placementXYZ(ents, plRef, memo = new Map()) {
  if (!plRef || !ents.has(plRef)) return [0,0,0];
  if (memo.has(plRef)) return memo.get(plRef);
  const pl = ents.get(plRef); const a = splitArgs(pl.raw);
  const parentRef = a[0] && a[0].startsWith("#") ? a[0] : null;
  const axisRef = a[1] && a[1].startsWith("#") ? a[1] : null;
  let local = [0,0,0];
  if (axisRef && ents.has(axisRef)) {
    const ax = splitArgs(ents.get(axisRef).raw);
    const ptRef = ax[0];
    if (ptRef && ents.has(ptRef)) {
      const coords = ents.get(ptRef).raw.match(/\(([^)]*)\)/);
      if (coords) local = coords[1].split(",").map(Number);
    }
  }
  const parent = parentRef ? placementXYZ(ents, parentRef, memo) : [0,0,0];
  const xyz = [parent[0]+(local[0]||0), parent[1]+(local[1]||0), parent[2]+(local[2]||0)];
  memo.set(plRef, xyz); return xyz;
}

const EARTH_ROOT = "4did:h3:8000000000000ff:AAAAAAAAAAAAAAAAAAAAAA:20260101T000000Z"; // Earth domain root (fixed)
const SPATIAL = new Set(["IFCPROJECT","IFCSITE","IFCBUILDING","IFCBUILDINGSTOREY","IFCSPACE"]);
const ELEMENT_CLASS = {
  IFCWINDOW: "built:window", IFCDOOR: "built:door", IFCWALL: "built:wall",
  IFCSLAB: "built:slab", IFCCOLUMN: "built:column", IFCBEAM: "built:beam", IFCSTAIR: "built:stair"
};
const SPATIAL_CLASS = {
  IFCPROJECT: "built:project", IFCSITE: "built:site", IFCBUILDING: "built:building",
  IFCBUILDINGSTOREY: "built:floor", IFCSPACE: "built:space"
};

export function importIFC(text, { siteLat = null, siteLng = null } = {}) {
  const ents = parseStep(text);

  // find site georeference (RefLatitude/RefLongitude on IFCSITE), IFC gives DMS arrays
  let lat = siteLat, lng = siteLng;
  for (const e of ents.values()) {
    if (e.type === "IFCSITE") {
      const a = splitArgs(e.raw);
      // RefLatitude and RefLongitude are compound like (33,42,45)
      const dms = a.map(x => x).filter(x => /^\(-?\d+,-?\d+,-?\d+/.test(x));
      const toDeg = t => { const [d,m,s] = t.replace(/[()]/g,"").split(",").map(Number); return (d<0?-1:1)*(Math.abs(d)+m/60+s/3600); };
      if (dms.length >= 2) { if (lat==null) lat = toDeg(dms[0]); if (lng==null) lng = toDeg(dms[1]); }
    }
  }
  if (lat == null || lng == null) { lat = lat ?? 0; lng = lng ?? 0; } // fall back; caller can override

  // build parent map from IfcRelAggregates (spatial) and IfcRelContainedInSpatialStructure (elements)
  const parentOf = new Map();
  const label = new Map();      // ifc ref -> human name
  const globalId = new Map();   // ifc ref -> IFC GlobalId
  const typeOf = new Map();
  const placement = new Map();

  for (const e of ents.values()) {
    const a = splitArgs(e.raw);
    if (SPATIAL.has(e.type) || ELEMENT_CLASS[e.type]) {
      globalId.set(e.id, str(a[0]));
      label.set(e.id, str(a[2]) || str(a[4]) || e.type);
      typeOf.set(e.id, e.type);
      // placement ref is the ObjectPlacement attribute; find the #ref that is an IFCLOCALPLACEMENT
      const plRef = a.find(x => x.startsWith("#") && ents.get(x)?.type === "IFCLOCALPLACEMENT");
      if (plRef) placement.set(e.id, plRef);
    }
    if (e.type === "IFCRELAGGREGATES") {
      const rs = refs(e.raw);
      // args: GlobalId, OwnerHistory, Name, Desc, RelatingObject, (RelatedObjects...)
      const relating = a[4];
      const related = refs(a[5] || "");
      for (const c of related) parentOf.set(c, relating);
    }
    if (e.type === "IFCRELCONTAINEDINSPATIALSTRUCTURE") {
      // args: ..., (RelatedElements...), RelatingStructure
      const related = refs(a[4] || "");
      const relating = a[5];
      for (const c of related) parentOf.set(c, relating);
    }
  }

  // emit entities in hierarchy order (project first)
  const order = [...typeOf.keys()].sort((x,y) => (SPATIAL.has(typeOf.get(x))?0:1) - (SPATIAL.has(typeOf.get(y))?0:1));
  const idFor = new Map();
  const out = [];
  const memo = new Map();
  let floorIndex = 0;

  for (const ref of order) {
    const t = typeOf.get(ref);
    const cls = SPATIAL_CLASS[t] || ELEMENT_CLASS[t] || "built:element";
    let vref = null;
    if (t === "IFCBUILDINGSTOREY") vref = `floor.${floorIndex++}`;
    const m = mint(lat, lng, vref);
    idFor.set(ref, m.id);
    const xyz = placement.get(ref) ? placementXYZ(ents, placement.get(ref), memo) : [0,0,0];
    const parentRef = parentOf.get(ref);
    const parent = (parentRef && idFor.get(parentRef)) || EARTH_ROOT;

    const ent = {
      id: m.id,
      parent,
      anchor: { variant: "h3", cell: m.cell, resolution: 12 },
      pose: { position: xyz, orientation: [0,0,0,1] },
      time: { source: new Date().toISOString(), bound_s: 0, publish: new Date().toISOString() },
      sequence: 1, producer: "adapter:ifc", validity_s: 31536000,
      status: "active", motion_mode: "static", layer: "public",
      labels: [{ text: label.get(ref) || t, source: "ifc" }],
      relations: [
        { type: "identified_as", registry: "ifc.globalid", external_id: globalId.get(ref) }
      ],
      ext: { semantics: { class: cls, affordances: t==="IFCWALL"||t==="IFCSLAB"||t==="IFCCOLUMN"?["structural","immovable","collidable"]:(t==="IFCWINDOW"||t==="IFCDOOR"?["openable","occluder"]:["collidable"]), provenance: { method:"ifc-import", model:"ifc-adapter" } } }
    };
    out.push(ent);
  }
  return { entities: out, siteLat: lat, siteLng: lng };
}
