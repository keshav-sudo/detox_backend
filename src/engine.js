function safe(obj, ...keys) {
  let cur = obj || {};
  for (const key of keys) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[key];
  }
  return cur;
}

export async function calculateDopamine(catalogCol, activityId, durationMin) {
  const act = await catalogCol.findOne({ id: activityId }, { projection: { _id: 0 } });
  if (!act) throw new Error(`Activity not found: ${activityId}`);

  const di = act.dopamine_impact || {};
  const cons = act.consequences || {};
  const peakMin = safe(di, "peak_units_min") ?? 120;
  const peakMax = safe(di, "peak_units_max") ?? 160;
  const typical = act.typical_duration_min || 30;
  const ratio = Math.min(1.5, Math.max(0.4, (durationMin || typical) / Math.max(1, typical)));
  const peakDopamine = Math.round((((peakMin + peakMax) / 2) * ratio) * 10) / 10;
  let crashPercent = safe(di, "crash_below_baseline_percent") ?? 0;
  if (act.is_healthy_spike) crashPercent = Math.max(0, crashPercent);
  const pfcHours = safe(cons, "pfc_impairment_hours") ?? 0;
  const brainFogUntil = new Date(Date.now() + Number(pfcHours || 0) * 3600_000).toISOString();
  let focusCapacity = safe(cons, "focus_capacity_after_percent");
  if (focusCapacity == null) focusCapacity = act.is_healthy_spike ? 90 : 80;

  return {
    activityId: act.id,
    activityName: act.name,
    activityEmoji: act.emoji || "",
    isHealthy: Boolean(act.is_healthy_spike),
    durationMin,
    peakDopamine,
    baseline: safe(di, "baseline_units") ?? 100,
    crashPercent,
    crashDurationHours: safe(di, "crash_duration_hours") ?? 0,
    brainFogUntil,
    pfcImpairmentHours: pfcHours,
    focusCapacity,
    attentionResidueMin: safe(cons, "attention_residue_minutes") ?? 0,
    cortisolIncreasePct: safe(cons, "cortisol_increase_percent") ?? 0,
    anxietyIncreasePct: safe(cons, "anxiety_increase_percent") ?? 0,
    motivationImpactPct: safe(cons, "motivation_impact_percent") ?? 0,
    productivityLossPct: safe(cons, "productivity_loss_percent") ?? 0,
    mechanismSimple: safe(di, "mechanism_simple") ?? "",
    isSupernormal: Boolean(safe(di, "is_supernormal_stimulus") ?? false),
    severity: act.severity || "low",
    calculatedAt: new Date().toISOString(),
  };
}
