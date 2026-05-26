import express from "express";

export function registerCatalogRoutes(app, db) {
  const router = express.Router();

  router.get("/", async (req, res) => {
    const { q, severity, healthy, phase, category_id } = req.query;
    const limit = Math.min(Number(req.query.limit || 200), 500);
    const filter = {};
    if (severity) filter.severity = severity;
    if (healthy !== undefined) filter.is_healthy_spike = healthy === "true";
    if (phase !== undefined && phase !== "") filter.phase = Number(phase);
    if (category_id) filter.category_id = category_id;
    if (q) {
      filter.$or = [
        { name: { $regex: q, $options: "i" } },
        { id: { $regex: q, $options: "i" } },
        { category_name: { $regex: q, $options: "i" } },
        { tags: { $elemMatch: { $regex: q, $options: "i" } } },
      ];
    }
    const items = await db.collection("activity_catalog").find(filter, { projection: { _id: 0 } }).limit(limit).toArray();
    res.json({ items, count: items.length });
  });

  router.get("/categories", async (_req, res) => {
    const items = await db.collection("activity_catalog").aggregate([
      {
        $group: {
          _id: "$category_id",
          name: { $first: "$category_name" },
          emoji: { $first: "$category_emoji" },
          phase: { $first: "$phase" },
          isHealthy: { $first: "$is_healthy_category" },
          count: { $sum: 1 },
        },
      },
      { $sort: { phase: 1 } },
    ]).toArray();
    res.json({
      items: items.map(({ _id, ...rest }) => ({
        ...rest,
        category_id: _id,
      })),
    });
  });

  router.get("/:activityId", async (req, res) => {
    const a = await db.collection("activity_catalog").findOne({ id: req.params.activityId }, { projection: { _id: 0 } });
    if (!a) return res.status(404).json({ detail: "Activity not found" });
    const reps = a?.recovery?.replacement_activities || [];
    if (reps.length) {
      const ids = reps.map((r) => r.activity_id).filter(Boolean);
      const refs = await db.collection("activity_catalog").find(
        { id: { $in: ids } },
        { projection: { _id: 0, id: 1, name: 1, emoji: 1, severity: 1, is_healthy_spike: 1 } },
      ).toArray();
      const refMap = new Map(refs.map((r) => [r.id, r]));
      for (const r of reps) {
        const ref = refMap.get(r.activity_id);
        if (ref) {
          r.name = ref.name;
          r.emoji = ref.emoji;
          r.severity = ref.severity;
          r.resolved = true;
        } else {
          r.name = String(r.activity_id || "").replace(/[-_]/g, " ");
          r.emoji = "✨";
          r.severity = "beneficial";
          r.resolved = false;
        }
      }
    }
    const comps = a?.ai_layer?.comparison_activities || [];
    if (comps.length) {
      const ids = comps.map((c) => c.activity_id).filter(Boolean);
      const refs = await db.collection("activity_catalog").find(
        { id: { $in: ids } },
        { projection: { _id: 0, id: 1, name: 1, emoji: 1 } },
      ).toArray();
      const refMap = new Map(refs.map((r) => [r.id, r]));
      for (const c of comps) {
        const ref = refMap.get(c.activity_id);
        if (ref) {
          c.name = ref.name;
          c.emoji = ref.emoji;
          c.resolved = true;
        } else {
          c.name = String(c.activity_id || "").replace(/[-_]/g, " ");
          c.emoji = "✨";
          c.resolved = false;
        }
      }
    }
    res.json(a);
  });

  app.use("/api/catalog", router);
}
