import { newId } from "../auth.js";
import { nowIso } from "../lib/http.js";

export async function updateStreak(db, userId, activityId, today, isHealthy) {
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

export async function checkMilestone(db, io, userId, activityId, streakDoc) {
  const cs = streakDoc?.currentStreak || 0;
  if (![1, 7, 21, 30].includes(cs)) return null;
  const hit = streakDoc?.milestonesHit || [];
  if (hit.includes(cs)) return null;

  const act = await db.collection("activity_catalog").findOne({ id: activityId }, { projection: { _id: 0 } });
  const msgMap = act?.ai_layer?.milestone_messages || {};
  const msg = msgMap[`day_${cs}`] || `Day ${cs} streak - amazing!`;
  await db.collection("streaks").updateOne(
    { userId, activityId, type: streakDoc.type || "abstain" },
    { $addToSet: { milestonesHit: cs } },
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
  io.to(`user:${userId}`).emit("milestone", notif);
  const memberships = await db.collection("pod_memberships").find({ userId }, { projection: { _id: 0 } }).toArray();
  for (const m of memberships) {
    io.to(`pod:${m.podId}`).emit("pod:milestone", { ...notif, podId: m.podId });
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
