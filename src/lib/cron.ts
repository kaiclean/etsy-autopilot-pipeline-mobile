const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Human label for the small subset of cron expressions this app uses (UTC). */
export function describeCron(expr: string) {
  const [min, hour, dom, mon, dow] = expr.trim().split(/\s+/);
  if (!dow) return expr;
  const pad = (n: string) => n.padStart(2, "0");
  if (min.startsWith("*/") && hour === "*") return `Every ${min.slice(2)} min`;
  if (hour.startsWith("*/") && dom === "*") return `Every ${hour.slice(2)} h at :${pad(min)}`;
  const time = /^\d+$/.test(hour) && /^\d+$/.test(min) ? `${pad(hour)}:${pad(min)} UTC` : `${hour}:${min}`;
  if (dom === "*" && mon === "*" && dow === "*") return `Daily ${time}`;
  if (dom === "*" && mon === "*" && /^\d$/.test(dow)) return `${DOW[Number(dow)]}s ${time}`;
  return expr;
}

/** Next fire time for simple "m h * * *" or "m h * * d" expressions; null for anything else. */
export function nextRun(expr: string, from = new Date()): Date | null {
  const [min, hour, dom, mon, dow] = expr.trim().split(/\s+/);
  if (dom !== "*" || mon !== "*" || !/^\d+$/.test(min) || !/^\d+$/.test(hour)) return null;
  for (let i = 0; i < 8; i++) {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + i, Number(hour), Number(min)));
    if (d <= from) continue;
    if (dow !== "*" && d.getUTCDay() !== Number(dow)) continue;
    return d;
  }
  return null;
}
