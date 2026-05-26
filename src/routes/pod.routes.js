import express from "express";
import { decodeToken, getBearerToken, newId } from "../auth.js";
import { nowIso, serialize } from "../lib/http.js";

function authMiddleware(req, res, next) {
  const token = getBearerToken(req.headers.authorization);
  if (!token) return res.status(401).json({ detail: "Missing Authorization header" });
  try {
    const payload = decodeToken(token);
    if (!payload?.sub) return res.status(401).json({ detail: "Invalid token payload" });
    req.userId = payload.sub;
    next();
  } catch (err) {
    res.status(401).json({ detail: `Invalid token: ${err.message}` });
  }
}

export function registerPodRoutes(app, db, io) {
  const router = express.Router();

  router.post("/", authMiddleware, async (req, res) => {
    const { name, description = "", isPublic = true } = req.body || {};
    if (!name) return res.status(400).json({ detail: "Missing name" });
    const podId = newId();
    const pod = {
      id: podId,
      name,
      description,
      isPublic: Boolean(isPublic),
      ownerId: req.userId,
      memberCount: 1,
      createdAt: nowIso(),
    };
    await db.collection("pods").insertOne(pod);
    const user = await db.collection("users").findOne({ id: req.userId }, { projection: { _id: 0 } });
    await db.collection("pod_memberships").insertOne({
      id: newId(),
      podId,
      userId: req.userId,
      userName: user?.name || "User",
      role: "owner",
      joinedAt: nowIso(),
    });
    await db.collection("pod_feed").insertOne({
      id: newId(),
      podId,
      type: "system",
      message: `${user?.name || "Someone"} created the pod 🎉`,
      createdAt: nowIso(),
    });
    res.json(serialize(pod));
  });

  router.get("/", authMiddleware, async (req, res) => {
    const scope = String(req.query.scope || "all");
    let pods = [];
    if (scope === "joined") {
      const memberships = await db.collection("pod_memberships").find({ userId: req.userId }, { projection: { _id: 0 } }).toArray();
      const ids = memberships.map((m) => m.podId);
      pods = await db.collection("pods").find({ id: { $in: ids } }, { projection: { _id: 0 } }).toArray();
    } else {
      pods = await db.collection("pods").find({ isPublic: true }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(40).toArray();
    }
    const my = new Set((await db.collection("pod_memberships").find({ userId: req.userId }, { projection: { _id: 0 } }).toArray()).map((m) => m.podId));
    for (const p of pods) p.isMember = my.has(p.id);
    res.json({ items: pods });
  });

  router.post("/:podId/join", authMiddleware, async (req, res) => {
    const pod = await db.collection("pods").findOne({ id: req.params.podId });
    if (!pod) return res.status(404).json({ detail: "Pod not found" });
    if ((pod.memberCount || 0) >= 8) return res.status(400).json({ detail: "Pod is full (max 8)" });
    const existing = await db.collection("pod_memberships").findOne({ podId: req.params.podId, userId: req.userId });
    if (existing) return res.json({ ok: true, alreadyMember: true });
    const user = await db.collection("users").findOne({ id: req.userId }, { projection: { _id: 0 } });
    await db.collection("pod_memberships").insertOne({
      id: newId(),
      podId: req.params.podId,
      userId: req.userId,
      userName: user?.name || "User",
      role: "member",
      joinedAt: nowIso(),
    });
    await db.collection("pods").updateOne({ id: req.params.podId }, { $inc: { memberCount: 1 } });
    const feed = {
      id: newId(),
      podId: req.params.podId,
      type: "joined",
      userId: req.userId,
      userName: user?.name || "User",
      message: `${user?.name || "User"} joined the pod 👋`,
      createdAt: nowIso(),
    };
    await db.collection("pod_feed").insertOne(feed);
    io.to(`pod:${req.params.podId}`).emit("pod:joined", feed);
    res.json({ ok: true });
  });

  router.post("/:podId/leave", authMiddleware, async (req, res) => {
    const result = await db.collection("pod_memberships").deleteOne({ podId: req.params.podId, userId: req.userId });
    if (result.deletedCount) {
      await db.collection("pods").updateOne({ id: req.params.podId }, { $inc: { memberCount: -1 } });
    }
    res.json({ ok: true });
  });

  router.get("/:podId", authMiddleware, async (req, res) => {
    const pod = await db.collection("pods").findOne({ id: req.params.podId }, { projection: { _id: 0 } });
    if (!pod) return res.status(404).json({ detail: "Pod not found" });
    const members = await db.collection("pod_memberships").find({ podId: req.params.podId }, { projection: { _id: 0 } }).toArray();
    const feed = await db.collection("pod_feed").find({ podId: req.params.podId }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(50).toArray();
    const leaderboard = [];
    for (const m of members) {
      const rows = await db.collection("streaks").find({ userId: m.userId }, { projection: { _id: 0 } }).toArray();
      const total = rows.reduce((sum, r) => sum + (r.currentStreak || 0), 0);
      const longest = rows.reduce((max, r) => Math.max(max, r.longestStreak || 0), 0);
      leaderboard.push({ userId: m.userId, userName: m.userName || "User", totalStreak: total, longestStreak: longest, role: m.role });
    }
    leaderboard.sort((a, b) => b.totalStreak - a.totalStreak);
    pod.isMember = members.some((m) => m.userId === req.userId);
    res.json({ pod, members, feed, leaderboard });
  });

  router.post("/:podId/support", authMiddleware, async (req, res) => {
    const msg = String(req.body?.message || "").trim() || "Sending support! ✨";
    const user = await db.collection("users").findOne({ id: req.userId }, { projection: { _id: 0 } });
    const feed = {
      id: newId(),
      podId: req.params.podId,
      type: "support",
      userId: req.userId,
      userName: user?.name || "User",
      message: msg,
      createdAt: nowIso(),
    };
    await db.collection("pod_feed").insertOne(feed);
    io.to(`pod:${req.params.podId}`).emit("pod:support", feed);
    res.json(serialize(feed));
  });

  app.use("/api/pods", router);
}
