import express from "express";
import { decodeToken, getBearerToken, hashPassword, issueToken, newId, verifyPassword } from "../auth.js";
import { nowIso, serialize } from "../lib/http.js";

const VALID_COUPONS = {
  keshav355: { plan: "pro", label: "Founder's pass - Pro unlocked" },
  DETOX2026: { plan: "pro", label: "Pro - 1 year" },
};

export function registerAuthRoutes(app, db) {
  const router = express.Router();

  const authMiddleware = (req, res, next) => {
    const token = getBearerToken(req.headers.authorization);
    if (!token) return res.status(401).json({ detail: "Missing Authorization header" });
    try {
      const payload = decodeToken(token);
      if (!payload?.sub) return res.status(401).json({ detail: "Invalid token payload" });
      req.userId = payload.sub;
      req.tokenPayload = payload;
      next();
    } catch (err) {
      res.status(401).json({ detail: `Invalid token: ${err.message}` });
    }
  };

  router.post("/register", async (req, res) => {
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

  router.post("/login", async (req, res) => {
    const { email, password } = req.body || {};
    const u = await db.collection("users").findOne({ email: String(email || "").toLowerCase() });
    if (!u || !verifyPassword(String(password || ""), u.passwordHash || "")) {
      return res.status(401).json({ detail: "Invalid credentials" });
    }
    const token = issueToken(u.id, u.email);
    res.json({ token, user: serialize({ ...u, passwordHash: null }) });
  });

  router.get("/me", authMiddleware, async (req, res) => {
    const u = await db.collection("users").findOne({ id: req.userId });
    if (!u) return res.status(404).json({ detail: "User not found" });
    res.json(serialize({ ...u, passwordHash: null }));
  });

  router.patch("/plan", authMiddleware, async (req, res) => {
    const newPlan = req.body?.plan || "free";
    await db.collection("users").updateOne({ id: req.userId }, { $set: { plan: newPlan } });
    res.json({ ok: true, plan: newPlan });
  });

  router.post("/redeem-coupon", authMiddleware, async (req, res) => {
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
      { $set: { plan: matched.plan }, $addToSet: { redeemedCoupons: code.toLowerCase() } },
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

  app.use("/api/auth", router);
}
