export function nowIso() {
  return new Date().toISOString();
}

export function serialize(doc) {
  if (doc === null || doc === undefined) return doc;
  if (Array.isArray(doc)) return doc.map(serialize);
  if (typeof doc !== "object") return doc;
  const out = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === "_id") continue;
    out[k] = v instanceof Date ? v.toISOString() : serialize(v);
  }
  return out;
}

export function slugToName(slug = "") {
  return String(slug)
    .replace(/[-_]/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
