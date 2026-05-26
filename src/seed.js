import fs from "fs/promises";
import { DATA_FILE } from "./config.js";

export async function seedCatalog(db, force = false) {
  let rawText = "";
  try {
    rawText = await fs.readFile(DATA_FILE, "utf8");
  } catch {
    return 0;
  }

  const existing = await db.collection("activity_catalog").countDocuments({});
  if (existing && !force) {
    try {
      await db.collection("activity_catalog").createIndex({ id: 1 }, { unique: true });
    } catch {}
    return existing;
  }

  const raw = JSON.parse(rawText);
  const docs = [];
  for (const phase of raw.phases || []) {
    const cat = phase.category || {};
    for (const sub of cat.sub_activities || []) {
      docs.push({
        ...sub,
        phase: phase.phase,
        category_id: cat.category_id,
        category_name: cat.category_name,
        category_emoji: cat.category_emoji,
        category_priority: cat.priority_rank,
        category_description: cat.category_description,
        is_healthy_category: cat.is_healthy_category || false,
      });
    }
  }

  if (force) await db.collection("activity_catalog").deleteMany({});
  if (docs.length) await db.collection("activity_catalog").insertMany(docs);

  try {
    await db.collection("activity_catalog").createIndex({ id: 1 }, { unique: true });
    await db.collection("activity_catalog").createIndex({ severity: 1 });
    await db.collection("activity_catalog").createIndex({ phase: 1 });
    await db.collection("activity_catalog").createIndex({ category_id: 1 });
    await db.collection("activity_catalog").createIndex({ is_healthy_spike: 1 });
  } catch {}

  return docs.length;
}
