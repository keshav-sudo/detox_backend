function fallback(activity, key, generic) {
  return (activity?.ai_layer || {})[key] || generic;
}

export async function cravingResponse(activity, recentLogs, urgeRating = 7) {
  const summary = (recentLogs || [])
    .slice(0, 3)
    .map((l) => `${l.activityName || "?"} (${l.durationMin || 0} min)`)
    .join(", ") || "no recent logs";
  return fallback(activity, "craving_response_script", "Bhai, 10 min ruko. Paani peeyo, deep saans lo.");
}

export async function relapseResponse(activity) {
  return fallback(activity, "relapse_response_script", "Slip ho gaya toh ho gaya. Kal phir start.");
}

export async function dailyInsight(activityLogsToday) {
  if (!activityLogsToday?.length) {
    return "Aaj chhota sa step lo - bas 10 min koi healthy activity. Brain dhanyavaad bolega.";
  }
  return "Aaj ke logs dekh kar lagta hai tum sahi raah pe ho. Ek aur chhota step lo - kya kar sakte ho abhi?";
}
