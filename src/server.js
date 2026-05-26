import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import express from "express";
import { MongoClient } from "mongodb";
import { CORS_ORIGINS, DB_NAME, MONGO_URL, PORT } from "./config.js";
import { calculateDopamine } from "./engine.js";
import { cravingResponse, dailyInsight, relapseResponse } from "./coach.js";
import { createSocketServer } from "./socket.js";
import { decodeToken, getBearerToken, hashPassword, issueToken, newId, verifyPassword } from "./auth.js";
import { seedCatalog } from "./seed.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
if (!MONGO_URL) {
  throw new Error("MONGO_URL is required");
}

const app = express();
const server = http.createServer(app);
const io = createSocketServer(server);
const client = new MongoClient(MONGO_URL);
await client.connect();
const db = client.db(DB_NAME);

app.use(cors({
  origin: CORS_ORIGINS.includes("*") ? true : CORS_ORIGINS,
  credentials: true,
}));
app.use(express.json({ limit: "2mb" }));

const VALID_COUPONS = {
  keshav355: { plan: "pro", label: "Founder's pass - Pro unlocked" },
  DETOX2026: { plan: "pro", label: "Pro - 1 year" },
};

function nowIso() {
  return new Date().toISOString();
}

function serialize(doc) {
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

function slugToName(slug = "") {
  return String(slug)
    .replace(/[-_]/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function authMiddleware(req, res, next) {
  const token = getBearerToken(req.headers.authorization);
  if (!token) {
    res.status(401).json({ detail: "Missing Authorization header" });
    return;
  }
  try {
    const payload = decodeToken(token);
    if (!payload?.sub) {
      res.status(401).json({ detail: "Invalid token payload" });
      return;
    }
    req.userId = payload.sub;
    req.tokenPayload = payload;
    next();
  } catch (err) {
    res.status(401).json({ detail: `Invalid token: ${err.message}` });
  }
}

async function ensureDemoUser() {
  const users = db.collection("users");
  const existing = await users.findOne({ email: "demo@detoxos.app" });
  if (existing) return;
  await users.insertOne({
    id: newId(),
    email: "demo@detoxos.app",
    name: "Rahul Demo",
    passwordHash: hashPassword("demo1234"),
    plan: "pro",
    problemActivities: ["instagram_reels", "pubg_freefire"],
    badges: [],
    createdAt: nowIso(),
  });
}

async function updateStreak(userId, activityId, today, isHealthy) {
  const streaks = db.collection("streaks");
  const key = { userId, activityId, type: isHealthy ? "healthy" : "abstain" };
  const cur = await streaks.findOne(key);
  if (!cur) {
    const doc = {
      ...key,
      currentStreak: 1,
      longestStreak: 1,
      startedAt: today.toISOString(),
      lastCheckIn: today.toISOString(),
      milestonesHit: [],
    };
    await streaks.insertOne(doc);
    return doc;
  }
  const last = cur.lastCheckIn ? new Date(cur.lastCheckIn) : today;
  const todayStart = new Date(today);
  todayStart.setHours(0, 0, 0, 0);
  const lastStart = new Date(last);
  lastStart.setHours(0, 0, 0, 0);
  const deltaDays = Math.floor((todayStart.getTime() - lastStart.getTime()) / 86400000);
  if (deltaDays === 0) return cur;
  const newStreak = deltaDays === 1 ? (cur.currentStreak || 0) + 1 : 1;
  const update = {
    currentStreak: newStreak,
    longestStreak: Math.max(cur.longestStreak || 0, newStreak),
    lastCheckIn: today.toISOString(),
  };
  await streaks.updateOne(key, { $set: update });
  return { ...cur, ...update };
}

async function checkMilestone(userId, activityId, streakDoc) {
  const cs = streakDoc?.currentStreak || 0;
  if (![1, 7, 21, 30].includes(cs)) return null;
  const hit = streakDoc?.milestonesHit || [];
  if (hit.includes(cs)) return null;

  const act = await db.collection("activity_catalog").findOne({ id: activityId }, { projection: { _id: 0 } });
  const msgMap = act?.ai_layer?.milestone_messages || {};
  const msg = msgMap[`day_${cs}`] || `Day ${cs} streak - amazing!`;
  await db.collection("streaks").updateOne(
    { userId, activityId, type: streakDoc.type || "abstain" },
    { $addToSet: { milestonesHit: cs } }
  );
  const notif = {
    id: newId(),
    userId,
    type: "milestone",
    title: `Day ${cs} milestone unlocked!`,
    body: msg,
    activityId,
    streak: cs,
    createdAt: nowIso(),
    read: false,
  };
  await db.collection("notifications").insertOne(notif);
  addSocketEmit("milestone", notif, `user:${userId}`);
  const memberships = await db.collection("pod_memberships").find({ userId }, { projection: { _id: 0 } }).toArray();
  for (const m of memberships) {
    addSocketEmit("pod:milestone", { ...notif, podId: m.podId }, `pod:${m.podId}`);
    await db.collection("pod_feed").insertOne({
      id: newId(),
      podId: m.podId,
      type: "milestone",
      userId,
      activityId,
      streak: cs,
      message: msg,
      createdAt: nowIso(),
    });
  }
  return notif;
}

function addSocketEmit(event, payload, room) {
  io.to(room).emit(event, payload);
}

app.get("/api", async (_req, res) => {
  const cnt = await db.collection("activity_catalog").countDocuments({});
  res.json({ ok: true, activityCatalogCount: cnt, ts: nowIso() });
});

app.post("/api/auth/register", async (req, res) => {
  const { email, password, name, plan = "free", problemActivities = [] } = req.body || {};
  if (!email || !password || !name) {
    return res.status(400).json({ detail: "Missing required fields" });
  }
  const users = db.collection("users");
  const normalized = String(email).toLowerCase();
  const existing = await users.findOne({ email: normalized });
  if (existing) return res.status(400).json({ detail: "Email already registered" });
  const userDoc = {
    id: newId(),
    email: normalized,
    name,
    passwordHash: hashPassword(password),
    plan: plan || "free",
    problemActivities: problemActivities || [],
    badges: [],
    createdAt: nowIso(),
  };
  await users.insertOne(userDoc);
  const token = issueToken(userDoc.id, userDoc.email);
  res.json({ token, user: serialize({ ...userDoc, passwordHash: null }) });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  const u = await db.collection("users").findOne({ email: String(email || "").toLowerCase() });
  if (!u || !verifyPassword(String(password || ""), u.passwordHash || "")) {
    return res.status(401).json({ detail: "Invalid credentials" });
  }
  const token = issueToken(u.id, u.email);
  res.json({ token, user: serialize({ ...u, passwordHash: null }) });
});

app.get("/api/auth/me", authMiddleware, async (req, res) => {
  const u = await db.collection("users").findOne({ id: req.userId });
  if (!u) return res.status(404).json({ detail: "User not found" });
  res.json(serialize({ ...u, passwordHash: null }));
});

app.patch("/api/auth/plan", authMiddleware, async (req, res) => {
  const newPlan = req.body?.plan || "free";
  await db.collection("users").updateOne({ id: req.userId }, { $set: { plan: newPlan } });
  res.json({ ok: true, plan: newPlan });
});

app.post("/api/auth/redeem-coupon", authMiddleware, async (req, res) => {
  const code = String(req.body?.code || "").trim();
  let matched = null;
  for (const [coupon, meta] of Object.entries(VALID_COUPONS)) {
    if (coupon.toLowerCase() === code.toLowerCase()) {
      matched = meta;
      break;
    }
  }
  if (!matched) return res.status(400).json({ detail: "Invalid coupon code" });
  const user = await db.collection("users").findOne({ id: req.userId });
  const redeemed = user?.redeemedCoupons || [];
  if (redeemed.map((c) => c.toLowerCase()).includes(code.toLowerCase())) {
    return res.json({ ok: true, plan: matched.plan, alreadyRedeemed: true, label: matched.label });
  }
  await db.collection("users").updateOne(
    { id: req.userId },
    { $set: { plan: matched.plan }, $addToSet: { redeemedCoupons: code.toLowerCase() } }
  );
  await db.collection("notifications").insertOne({
    id: newId(),
    userId: req.userId,
    type: "coupon_redeemed",
    title: `🎉 ${matched.label}`,
    body: `Coupon '${code}' redeemed. Welcome to ${matched.plan.toUpperCase()}!`,
    createdAt: nowIso(),
    read: false,
  });
  res.json({ ok: true, plan: matched.plan, label: matched.label });
});

app.get("/api/catalog", async (req, res) => {
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

app.get("/api/catalog/categories", async (_req, res) => {
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

app.get("/api/catalog/:activityId", async (req, res) => {
  const a = await db.collection("activity_catalog").findOne({ id: req.params.activityId }, { projection: { _id: 0 } });
  if (!a) return res.status(404).json({ detail: "Activity not found" });
  const reps = a?.recovery?.replacement_activities || [];
  if (reps.length) {
    const ids = reps.map((r) => r.activity_id).filter(Boolean);
    const refs = await db.collection("activity_catalog").find(
      { id: { $in: ids } },
      { projection: { _id: 0, id: 1, name: 1, emoji: 1, severity: 1, is_healthy_spike: 1 } }
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
        r.name = slugToName(r.activity_id || "");
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
      { projection: { _id: 0, id: 1, name: 1, emoji: 1 } }
    ).toArray();
    const refMap = new Map(refs.map((r) => [r.id, r]));
    for (const c of comps) {
      const ref = refMap.get(c.activity_id);
      if (ref) {
        c.name = ref.name;
        c.emoji = ref.emoji;
        c.resolved = true;
      } else {
        c.name = slugToName(c.activity_id || "");
        c.emoji = "✨";
        c.resolved = false;
      }
    }
  }
  res.json(a);
});

app.post("/api/logs", authMiddleware, async (req, res) => {
  const { activityId, durationMin, source = "manual", note = null } = req.body || {};
  let calc;
  try {
    calc = await calculateDopamine(db.collection("activity_catalog"), activityId, Number(durationMin || 0));
  } catch (err) {
    return res.status(404).json({ detail: err.message });
  }
  const today = new Date();
  const logDoc = {
    id: newId(),
    userId: req.userId,
    activityId,
    activityName: calc.activityName,
    durationMin: Number(durationMin || 0),
    source,
    note,
    dopamineCalc: calc,
    createdAt: today.toISOString(),
  };
  await db.collection("activity_logs").insertOne(logDoc);
  const streakDoc = await updateStreak(req.userId, activityId, today, calc.isHealthy);
  const milestone = await checkMilestone(req.userId, activityId, streakDoc);
  const statePayload = {
    userId: req.userId,
    focusCapacity: calc.focusCapacity,
    lastActivity: calc.activityName,
    lastEmoji: calc.activityEmoji || "",
    isHealthy: calc.isHealthy,
    streak: streakDoc.currentStreak,
    ts: today.toISOString(),
  };
  addSocketEmit("brain-state-update", statePayload, `user:${req.userId}`);
  const memberships = await db.collection("pod_memberships").find({ userId: req.userId }, { projection: { _id: 0 } }).toArray();
  const user = await db.collection("users").findOne({ id: req.userId }, { projection: { _id: 0, name: 1 } });
  for (const m of memberships) {
    const feedItem = {
      id: newId(),
      podId: m.podId,
      type: "activity_logged",
      userId: req.userId,
      userName: user?.name || "User",
      activityId,
      activityName: calc.activityName,
      activityEmoji: calc.activityEmoji || "",
      durationMin: Number(durationMin || 0),
      isHealthy: calc.isHealthy,
      createdAt: nowIso(),
    };
    await db.collection("pod_feed").insertOne(feedItem);
    addSocketEmit("pod:activity-logged", feedItem, `pod:${m.podId}`);
  }
  res.json({ log: serialize(logDoc), streak: serialize(streakDoc), milestone: serialize(milestone), calc });
});

app.get("/api/logs", authMiddleware, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const items = await db.collection("activity_logs")
    .find({ userId: req.userId }, { projection: { _id: 0 } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
  res.json({ items });
});

app.get("/api/logs/preview", authMiddleware, async (req, res) => {
  const activityId = String(req.query.activityId || "");
  const durationMin = Number(req.query.durationMin || 30);
  try {
    const calc = await calculateDopamine(db.collection("activity_catalog"), activityId, durationMin);
    res.json(calc);
  } catch (err) {
    res.status(404).json({ detail: err.message });
  }
});

app.get("/api/streaks", authMiddleware, async (req, res) => {
  const rows = await db.collection("streaks").find({ userId: req.userId }, { projection: { _id: 0 } }).toArray();
  const ids = [...new Set(rows.map((r) => r.activityId))];
  if (ids.length) {
    const acts = await db.collection("activity_catalog").find(
      { id: { $in: ids } },
      { projection: { _id: 0, id: 1, name: 1, emoji: 1, severity: 1, recovery: 1, ai_layer: 1, is_healthy_spike: 1 } }
    ).toArray();
    const amap = new Map(acts.map((a) => [a.id, a]));
    for (const r of rows) {
      const a = amap.get(r.activityId) || {};
      const recoveryDays = a?.recovery?.receptor_recovery_days || 30;
      const current = r.currentStreak || 0;
      r.recoveryTargetDays = recoveryDays;
      r.recoveryPercent = Math.min(100, Math.round((current / Math.max(1, recoveryDays)) * 100));
      r.activityName = a.name || r.activityId;
      r.activityEmoji = a.emoji || "🌟";
      r.severity = a.severity || "low";
      r.isHealthy = a.is_healthy_spike || false;
      r.hinglishLabel = a?.ai_layer?.hinglish_label;
    }
  }
  res.json({ items: rows });
});

app.post("/api/cravings/sos", authMiddleware, async (req, res) => {
  const { activityId, urgeRating = 7, timeOfDay = null, podId = null } = req.body || {};
  const act = await db.collection("activity_catalog").findOne({ id: activityId }, { projection: { _id: 0 } });
  if (!act) return res.status(404).json({ detail: "Activity not found" });
  const repsRaw = act?.recovery?.replacement_activities || [];
  const ranked = [...repsRaw].sort((a, b) => (b.dopamine_match_percent || 0) - (a.dopamine_match_percent || 0)).slice(0, 3);
  const ids = ranked.map((r) => r.activity_id).filter(Boolean);
  const enriched = [];
  if (ids.length) {
    const refs = await db.collection("activity_catalog").find({ id: { $in: ids } }, { projection: { _id: 0 } }).toArray();
    const refMap = new Map(refs.map((r) => [r.id, r]));
    for (const r of ranked) {
      const ref = refMap.get(r.activity_id) || {};
      enriched.push({
        activityId: r.activity_id,
        name: ref.name || slugToName(r.activity_id || ""),
        emoji: ref.emoji || "✨",
        match: r.dopamine_match_percent || 0,
        reason: r.reason,
        severity: ref.severity || "beneficial",
        isHealthy: ref.is_healthy_spike ?? true,
        resolved: Boolean(ref.id),
      });
    }
  }
  const recentLogs = await db.collection("activity_logs").find(
    { userId: req.userId },
    { projection: { _id: 0 } }
  ).sort({ createdAt: -1 }).limit(3).toArray();
  const flatLogs = recentLogs.map((l) => ({
    activityName: l.activityName,
    durationMin: l.durationMin,
    isHealthy: l?.dopamineCalc?.isHealthy || false,
  }));
  const user = await db.collection("users").findOne({ id: req.userId }, { projection: { _id: 0 } });
  const isPro = user?.plan === "pro";
  const coachText = isPro ? await cravingResponse(act, flatLogs, urgeRating) : (act?.ai_layer?.craving_response_script || "Bhai 10 min ruko, paani peeyo, deep saans lo. Urge khud chala jayega.");
  const event = {
    id: newId(),
    userId: req.userId,
    activityId,
    urgeRating,
    timeOfDay: timeOfDay || nowIso(),
    podId,
    replacementsShown: enriched.map((r) => r.activityId),
    coachText,
    isPro,
    outcome: null,
    createdAt: nowIso(),
  };
  await db.collection("craving_events").insertOne(event);
  if (podId) {
    const support = { podId, message: "Someone in your pod is surfing an urge - send support!", createdAt: nowIso() };
    addSocketEmit("pod:support-needed", support, `pod:${podId}`);
    await db.collection("pod_feed").insertOne({
      id: newId(),
      podId,
      type: "support_needed",
      message: "Anonymous pod-mate is surfing an urge",
      createdAt: nowIso(),
    });
  }
  res.json({
    event: serialize(event),
    replacements: enriched,
    coachText,
    isPro,
    fallbackScript: act?.ai_layer?.craving_response_script,
    hinglishLabel: act?.ai_layer?.hinglish_label,
  });
});

app.patch("/api/cravings/:eventId/outcome", authMiddleware, async (req, res) => {
  const outcome = req.body?.outcome;
  const ev = await db.collection("craving_events").findOne({ id: req.params.eventId, userId: req.userId });
  if (!ev) return res.status(404).json({ detail: "Event not found" });
  await db.collection("craving_events").updateOne({ id: req.params.eventId }, { $set: { outcome, outcomeAt: nowIso() } });
  let coachText = null;
  if (outcome === "slipped") {
    const act = await db.collection("activity_catalog").findOne({ id: ev.activityId }, { projection: { _id: 0 } });
    coachText = await relapseResponse(act || {}, 0);
  }
  res.json({ ok: true, outcome, coachText });
});

app.get("/api/cravings", authMiddleware, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 30), 100);
  const items = await db.collection("craving_events").find({ userId: req.userId }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(limit).toArray();
  res.json({ items });
});

app.post("/api/pods", authMiddleware, async (req, res) => {
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

app.get("/api/pods", authMiddleware, async (req, res) => {
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

app.post("/api/pods/:podId/join", authMiddleware, async (req, res) => {
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
  addSocketEmit("pod:joined", feed, `pod:${req.params.podId}`);
  res.json({ ok: true });
});

app.post("/api/pods/:podId/leave", authMiddleware, async (req, res) => {
  const result = await db.collection("pod_memberships").deleteOne({ podId: req.params.podId, userId: req.userId });
  if (result.deletedCount) {
    await db.collection("pods").updateOne({ id: req.params.podId }, { $inc: { memberCount: -1 } });
  }
  res.json({ ok: true });
});

app.get("/api/pods/:podId", authMiddleware, async (req, res) => {
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

app.post("/api/pods/:podId/support", authMiddleware, async (req, res) => {
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
  addSocketEmit("pod:support", feed, `pod:${req.params.podId}`);
  res.json(serialize(feed));
});

app.get("/api/reports", authMiddleware, async (req, res) => {
  const items = await db.collection("weekly_reports").find({ userId: req.userId }, { projection: { _id: 0 } }).sort({ weekEnd: -1 }).limit(20).toArray();
  res.json({ items });
});

app.post("/api/reports/generate", authMiddleware, async (req, res) => {
  const end = new Date();
  const start = new Date(Date.now() - 7 * 86400000);
  const items = await db.collection("activity_logs").aggregate([
    { $match: { userId: req.userId, createdAt: { $gte: start.toISOString() } } },
    {
      $group: {
        _id: "$activityId",
        totalMinutes: { $sum: "$durationMin" },
        sessions: { $sum: 1 },
        isHealthy: { $first: "$dopamineCalc.isHealthy" },
        activityName: { $first: "$activityName" },
        avgFocus: { $avg: "$dopamineCalc.focusCapacity" },
        avgCortisol: { $avg: "$dopamineCalc.cortisolIncreasePct" },
        avgFog: { $avg: "$dopamineCalc.pfcImpairmentHours" },
      },
    },
  ]).toArray();
  const healthyMin = items.filter((i) => i.isHealthy).reduce((sum, i) => sum + i.totalMinutes, 0);
  const unhealthyMin = items.filter((i) => !i.isHealthy).reduce((sum, i) => sum + i.totalMinutes, 0);
  const avgFocus = items.reduce((sum, i) => sum + (i.avgFocus || 0), 0) / Math.max(1, items.length);
  const avgCortisol = items.reduce((sum, i) => sum + (i.avgCortisol || 0), 0) / Math.max(1, items.length);
  const report = {
    id: newId(),
    userId: req.userId,
    weekStart: start.toISOString(),
    weekEnd: end.toISOString(),
    healthyMinutes: healthyMin,
    unhealthyMinutes: unhealthyMin,
    focusCapacityAvg: Math.round(avgFocus * 10) / 10,
    cortisolChangePct: Math.round(avgCortisol * 10) / 10,
    brainFogHoursSaved: Math.round((healthyMin * 0.05) * 10) / 10,
    moneySavedInr: Math.round(unhealthyMin * 2.5),
    breakdown: items.map((i) => ({
      activityId: i._id,
      activityName: i.activityName,
      totalMinutes: i.totalMinutes,
      sessions: i.sessions,
      isHealthy: i.isHealthy || false,
    })),
    createdAt: nowIso(),
  };
  await db.collection("weekly_reports").insertOne(report);
  res.json(serialize(report));
});

app.get("/api/insights/daily", authMiddleware, async (req, res) => {
  const todayStart = new Date(Date.now() - 24 * 3600000).toISOString();
  const logs = await db.collection("activity_logs").find(
    { userId: req.userId, createdAt: { $gte: todayStart } },
    { projection: { _id: 0 } }
  ).sort({ createdAt: -1 }).limit(10).toArray();
  const flat = logs.map((l) => ({
    activityName: l.activityName,
    durationMin: l.durationMin,
    isHealthy: l?.dopamineCalc?.isHealthy || false,
  }));
  const streaks = await db.collection("streaks").find({ userId: req.userId }, { projection: { _id: 0 } }).toArray();
  const totalStreak = streaks.reduce((sum, s) => sum + (s.currentStreak || 0), 0);
  const user = await db.collection("users").findOne({ id: req.userId }, { projection: { _id: 0 } });
  const isPro = user?.plan === "pro";
  let insightText = "";
  if (isPro && flat.length) {
    insightText = await dailyInsight(flat, totalStreak);
  } else if (logs.length) {
    const act = await db.collection("activity_catalog").findOne({ id: logs[0].activityId }, { projection: { _id: 0 } });
    insightText = act?.ai_layer?.insight_templates?.[0] || "Aaj chhota sa step lo - bas 10 min koi healthy activity. Brain dhanyavaad bolega.";
  } else {
    insightText = "Aaj chhota sa step lo - bas 10 min koi healthy activity. Brain dhanyavaad bolega.";
  }
  let triggerQ = "Phone uthane se 1 second pehle - kya feel ho raha hai? Boredom, anxiety, ya habit?";
  if (logs.length) {
    const act = await db.collection("activity_catalog").findOne({ id: logs[0].activityId }, { projection: { _id: 0 } });
    const qs = act?.ai_layer?.trigger_questions || [];
    if (qs.length) triggerQ = qs[0];
  }
  res.json({
    insight: insightText,
    triggerQuestion: triggerQ,
    isPro,
    logsCount: logs.length,
    totalStreak,
  });
});

app.get("/api/notifications", authMiddleware, async (req, res) => {
  const items = await db.collection("notifications").find({ userId: req.userId }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(30).toArray();
  res.json({ items });
});

app.patch("/api/notifications/:nid/read", authMiddleware, async (req, res) => {
  await db.collection("notifications").updateOne({ id: req.params.nid, userId: req.userId }, { $set: { read: true } });
  res.json({ ok: true });
});

app.get("/", async (_req, res) => {
  const cnt = await db.collection("activity_catalog").countDocuments({});
  res.json({ ok: true, activityCatalogCount: cnt, ts: nowIso() });
});

await seedCatalog(db);
await ensureDemoUser();

server.listen(PORT, () => {
  console.log(`DetoxOS Node backend listening on http://localhost:${PORT}`);
});

process.on("SIGINT", async () => {
  try {
    await client.close();
  } finally {
    process.exit(0);
  }
});
