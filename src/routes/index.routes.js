import express from "express";

export function registerIndexRoutes(app, db) {
  const router = express.Router();
  router.get("/", async (_req, res) => {
    const cnt = await db.collection("activity_catalog").countDocuments({});
    res.json({ ok: true, activityCatalogCount: cnt, ts: new Date().toISOString() });
  });
  app.use("/api", router);
}
