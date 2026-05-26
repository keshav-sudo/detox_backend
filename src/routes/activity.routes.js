import express from "express";
import { calculateDopamine } from "../engine.js";
import { cravingResponse, dailyInsight, relapseResponse } from "../coach.js";
import { decodeToken, getBearerToken, newId } from "../auth.js";
import { nowIso, serialize } from "../lib/http.js";
import { checkMilestone, updateStreak } from "../services/activityService.js";

const PLAN_STATUSES = new Set(["planned", "completed", "partial", "skipped", "replaced"]);

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

function getPlanDateKey(value) {
  const raw = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }
  return new Date().toISOString().slice(0, 10);
}

function clampPercent(value, fallback = 0) {
  const num = Number(value);
  if (Number.isNaN(num)) return fallback;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function clampMinutes(value, fallback = 30) {
  const num = Number(value);
  if (Number.isNaN(num)) return fallback;
  return Math.max(0, Math.min(1440, Math.round(num)));
}

function normalizePlanItem(item = {}, index = 0) {
  const requestedStatus = String(item.status || "planned").toLowerCase();
  const status = PLAN_STATUSES.has(requestedStatus) ? requestedStatus : "planned";
  let completionPercent = clampPercent(item.completionPercent, 0);
  if (status === "completed") completionPercent = 100;
  if (status === "skipped") completionPercent = 0;
  if (status === "planned" && !item.completionPercent) completionPercent = 0;

  return {
    id: String(item.id || newId()),
    order: Number.isFinite(Number(item.order)) ? Number(item.order) : index,
    title: String(item.title || "").trim(),
    startTime: String(item.startTime || "").trim(),
    plannedMinutes: clampMinutes(item.plannedMinutes, 30),
    status,
    completionPercent,
    replacementActivity: String(item.replacementActivity || "").trim(),
    notes: String(item.notes || "").trim(),
  };
}

function summarizePlanItems(items = []) {
  const valid = items.filter((item) => item.title);
  const totalTasks = valid.length;
  const totalPlannedMinutes = valid.reduce((sum, item) => sum + (item.plannedMinutes || 0), 0);
  const weightedCompletion = valid.reduce(
    (sum, item) => sum + ((item.plannedMinutes || 0) * (item.completionPercent || 0)),
    0,
  );
  const completedCount = valid.filter((item) => item.status === "completed").length;
  const partialCount = valid.filter((item) => item.status === "partial").length;
  const skippedCount = valid.filter((item) => item.status === "skipped").length;
  const replacedCount = valid.filter((item) => item.status === "replaced" || item.replacementActivity).length;

  return {
    totalTasks,
    completedCount,
    partialCount,
    skippedCount,
    replacedCount,
    totalPlannedMinutes,
    adherencePct: totalPlannedMinutes
      ? Math.round(weightedCompletion / totalPlannedMinutes)
      : 0,
  };
}

export function registerActivityRoutes(app, db, io) {
  const router = express.Router();

  router.post("/logs", authMiddleware, async (req, res) => {
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
    const streakDoc = calc.isHealthy
      ? await updateStreak(db, req.userId, activityId, today, calc.isHealthy)
      : null;
    const milestone = streakDoc
      ? await checkMilestone(db, io, req.userId, activityId, streakDoc)
      : null;
    io.to(`user:${req.userId}`).emit("brain-state-update", {
      userId: req.userId,
      focusCapacity: calc.focusCapacity,
      lastActivity: calc.activityName,
      lastEmoji: calc.activityEmoji || "",
      isHealthy: calc.isHealthy,
      streak: streakDoc?.currentStreak || 0,
      ts: today.toISOString(),
    });
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
      io.to(`pod:${m.podId}`).emit("pod:activity-logged", feedItem);
    }
    res.json({ log: serialize(logDoc), streak: serialize(streakDoc), milestone: serialize(milestone), calc });
  });

  router.get("/logs", authMiddleware, async (req, res) => {
    const limit = Math.min(Number(req.query.limit || 50), 200);
    const items = await db.collection("activity_logs")
      .find({ userId: req.userId }, { projection: { _id: 0 } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    res.json({ items });
  });

  router.get("/logs/preview", authMiddleware, async (req, res) => {
    const activityId = String(req.query.activityId || "");
    const durationMin = Number(req.query.durationMin || 30);
    try {
      const calc = await calculateDopamine(db.collection("activity_catalog"), activityId, durationMin);
      res.json(calc);
    } catch (err) {
      res.status(404).json({ detail: err.message });
    }
  });

  router.get("/streaks", authMiddleware, async (req, res) => {
    let rows = await db.collection("streaks").find({ userId: req.userId }, { projection: { _id: 0 } }).toArray();
    const ids = [...new Set(rows.map((r) => r.activityId))];
    if (ids.length) {
      const acts = await db.collection("activity_catalog").find(
        { id: { $in: ids } },
        { projection: { _id: 0, id: 1, name: 1, emoji: 1, severity: 1, recovery: 1, ai_layer: 1, is_healthy_spike: 1 } },
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
    rows = rows.filter((r) => r.isHealthy);
    res.json({ items: rows });
  });

  router.post("/cravings/sos", authMiddleware, async (req, res) => {
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
          name: ref.name || String(r.activity_id || "").replace(/[-_]/g, " "),
          emoji: ref.emoji || "✨",
          match: r.dopamine_match_percent || 0,
          reason: r.reason,
          severity: ref.severity || "beneficial",
          isHealthy: ref.is_healthy_spike ?? true,
          resolved: Boolean(ref.id),
        });
      }
    }
    const recentLogs = await db.collection("activity_logs").find({ userId: req.userId }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(3).toArray();
    const flatLogs = recentLogs.map((l) => ({
      activityName: l.activityName,
      durationMin: l.durationMin,
      isHealthy: l?.dopamineCalc?.isHealthy || false,
    }));
    const user = await db.collection("users").findOne({ id: req.userId }, { projection: { _id: 0 } });
    const isPro = user?.plan === "pro";
    const coachText = isPro
      ? await cravingResponse(act, flatLogs, urgeRating)
      : (act?.ai_layer?.craving_response_script || "Bhai 10 min ruko, paani peeyo, deep saans lo. Urge khud chala jayega.");
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
      io.to(`pod:${podId}`).emit("pod:support-needed", support);
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

  router.patch("/cravings/:eventId/outcome", authMiddleware, async (req, res) => {
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

  router.get("/cravings", authMiddleware, async (req, res) => {
    const limit = Math.min(Number(req.query.limit || 30), 100);
    const items = await db.collection("craving_events").find({ userId: req.userId }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(limit).toArray();
    res.json({ items });
  });

  router.get("/reports", authMiddleware, async (req, res) => {
    const items = await db.collection("weekly_reports").find({ userId: req.userId }, { projection: { _id: 0 } }).sort({ weekEnd: -1 }).limit(20).toArray();
    res.json({ items });
  });

  router.get("/day-plan/today", authMiddleware, async (req, res) => {
    const date = getPlanDateKey(req.query.date);
    const plan = await db.collection("day_plans").findOne(
      { userId: req.userId, date },
      { projection: { _id: 0 } },
    );
    if (!plan) {
      return res.json({
        id: null,
        userId: req.userId,
        date,
        title: "",
        items: [],
        summary: summarizePlanItems([]),
      });
    }
    return res.json(plan);
  });

  router.put("/day-plan/today", authMiddleware, async (req, res) => {
    const date = getPlanDateKey(req.body?.date);
    const title = String(req.body?.title || "").trim();
    const items = Array.isArray(req.body?.items)
      ? req.body.items.map((item, index) => normalizePlanItem(item, index)).filter((item) => item.title)
      : [];
    const summary = summarizePlanItems(items);
    const existing = await db.collection("day_plans").findOne(
      { userId: req.userId, date },
      { projection: { _id: 0, id: 1, createdAt: 1 } },
    );
    const doc = {
      id: existing?.id || newId(),
      userId: req.userId,
      date,
      title,
      items,
      summary,
      createdAt: existing?.createdAt || nowIso(),
      updatedAt: nowIso(),
    };
    await db.collection("day_plans").updateOne(
      { userId: req.userId, date },
      { $set: doc },
      { upsert: true },
    );
    res.json(serialize(doc));
  });

  router.get("/day-plan/analysis", authMiddleware, async (req, res) => {
    const days = Math.max(1, Math.min(Number(req.query.days || 7), 30));
    const start = new Date(Date.now() - ((days - 1) * 86400000)).toISOString().slice(0, 10);
    const plans = await db.collection("day_plans")
      .find({ userId: req.userId, date: { $gte: start } }, { projection: { _id: 0 } })
      .sort({ date: 1 })
      .toArray();

    const trend = plans.map((plan) => ({
      date: plan.date,
      adherencePct: plan.summary?.adherencePct || 0,
      totalTasks: plan.summary?.totalTasks || 0,
      completedCount: plan.summary?.completedCount || 0,
      replacedCount: plan.summary?.replacedCount || 0,
      skippedCount: plan.summary?.skippedCount || 0,
    }));
    const totalDaysPlanned = plans.filter((plan) => (plan.summary?.totalTasks || 0) > 0).length;
    const averageAdherence = trend.length
      ? Math.round(trend.reduce((sum, day) => sum + (day.adherencePct || 0), 0) / trend.length)
      : 0;
    const replacementCount = trend.reduce((sum, day) => sum + (day.replacedCount || 0), 0);
    const skippedCount = trend.reduce((sum, day) => sum + (day.skippedCount || 0), 0);
    const completedTasks = trend.reduce((sum, day) => sum + (day.completedCount || 0), 0);
    const totalTasks = trend.reduce((sum, day) => sum + (day.totalTasks || 0), 0);
    const bestDay = trend.reduce((best, day) => (
      !best || day.adherencePct > best.adherencePct ? day : best
    ), null);

    res.json({
      days,
      totalDaysPlanned,
      averageAdherence,
      replacementCount,
      skippedCount,
      completedTasks,
      totalTasks,
      bestDay,
      trend,
    });
  });

  router.post("/reports/generate", authMiddleware, async (req, res) => {
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

  router.get("/insights/daily", authMiddleware, async (req, res) => {
    const todayStart = new Date(Date.now() - 24 * 3600000).toISOString();
    const logs = await db.collection("activity_logs").find(
      { userId: req.userId, createdAt: { $gte: todayStart } },
      { projection: { _id: 0 } },
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

  router.get("/notifications", authMiddleware, async (req, res) => {
    const items = await db.collection("notifications").find({ userId: req.userId }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(30).toArray();
    res.json({ items });
  });

  router.patch("/notifications/:nid/read", authMiddleware, async (req, res) => {
    await db.collection("notifications").updateOne({ id: req.params.nid, userId: req.userId }, { $set: { read: true } });
    res.json({ ok: true });
  });

  app.use("/api", router);
}
