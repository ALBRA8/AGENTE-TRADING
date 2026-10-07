// ============================================================
// src/agent/doctor.ts
// DOCTOR DEL AGENTE (PROMPT 06 §20 — Task 10-c, diseño del auditor 9-i)
//
// runDoctor() agrega checks EXISTENTES en 9 secciones con veredicto
// OK / WARN / FAIL y un score 0-100. Es un AGREGADOR: no re-implementa
// lógica (§27) — llama a los módulos que ya saben medirse
// (risk_controls, policy, smc/live, skills/registry, sqlite).
//
// AUTO-REPAIR (runDoctorRepairs): SOLO operaciones deterministas,
// idempotentes y documentadas:
//   1. PRAGMA optimize (SQLite oficial, barato y seguro).
//   2. Purga de agent_errors RESUELTOS con más de 30 días.
//   3. Backfill agent_lessons.memory_type NULL → 'SEMANTIC'.
// NUNCA toca estrategia, gates, policy ni lecciones promovidas.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import db from "../database/sqlite.js";
import { MT5Bridge } from "../config/mt5bridge.js";
import { analyzeLiveStructure } from "../smc/live.js";
import { getRiskLimits, getAccountRisk } from "./risk_controls.js";
import { getPolicySummary } from "./policy.js";
import { computePipValueUSD } from "./tools/execute_trade_mt5.js";
import { getSkillsRegistry } from "../skills/registry.js";

// ── Tipos ───────────────────────────────────────────────────

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** "warn" = fallo tolerable (p.ej. bridge caído en demo): baja el score a
   *  la mitad pero NO hace FAIL la sección. Ausente = fallo duro. */
  severity?: "warn";
}

export interface DoctorSection {
  name: string;
  verdict: "OK" | "WARN" | "FAIL";
  checks: DoctorCheck[];
}

export interface DoctorReport {
  sections: DoctorSection[];
  /** 0-100: OK=1 punto, WARN=0.5, FAIL=0. */
  score: number;
  generatedAt: string;
}

function envPositiveInt(name: string, def: number): number {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

// ── Helpers de checks ───────────────────────────────────────

function sectionFrom(name: string, checks: DoctorCheck[]): DoctorSection {
  const hardFail = checks.some((c) => !c.ok && c.severity !== "warn");
  const softFail = checks.some((c) => !c.ok);
  return {
    name,
    verdict: hardFail ? "FAIL" : softFail ? "WARN" : "OK",
    checks,
  };
}

/** Bridge health con timeout corto (2.5s): no queremos colgar el doctor. */
async function bridgeHealthQuick(): Promise<boolean> {
  const timeoutMs = Math.min(envPositiveInt("BRIDGE_TIMEOUT_MS", 5_000), 2_500);
  return Promise.race([
    MT5Bridge.health().catch(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

/** Edad (minutos) de la última vela; null si el formato es ilegible. */
function lastCandleAgeMinutes(candles: Array<{ time: string }>): number | null {
  const last = candles[candles.length - 1];
  if (!last || typeof last.time !== "string") return null;
  const t = Date.parse(last.time);
  return Number.isFinite(t) ? (Date.now() - t) / 60_000 : null;
}

/** Serie sintética mínima (fixture): zigzag alcista como tests/risk_smc. */
function syntheticCandles(n: number) {
  const out: Array<{ time: string; open: number; high: number; low: number; close: number; tickVolume: number; realVolume: number; spread: number }> = [];
  let price = 100;
  let o = price;
  for (let i = 0; i < n; i++) {
    const impulse = i % 16 < 10;
    if (i > 0) o = impulse ? price + 0.05 : price - 0.05;
    price += impulse ? 0.3 : -0.3;
    const t = new Date(Date.now() - (n - i) * 60_000).toISOString();
    out.push({
      time: t,
      open: o,
      high: Math.max(o, price) + 0.1,
      low: Math.min(o, price) - 0.1,
      close: price,
      tickVolume: impulse ? 2000 : 600,
      realVolume: 0,
      spread: 2,
    });
  }
  return out;
}

function isLiveMode(): boolean {
  return getPolicySummary().mode === "LIVE" ||
    (process.env.LIVE_TRADING ?? "").trim().toLowerCase() === "true";
}

// ── El doctor ───────────────────────────────────────────────

export async function runDoctor(): Promise<DoctorReport> {
  const sections: DoctorSection[] = [];

  // ── 1. SYSTEM ─────────────────────────────────────────────
  const nodeMajor = parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  let integrity = "no verificada";
  let integrityOk = false;
  try {
    const rows = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    integrity = rows?.[0]?.integrity_check ?? "sin respuesta";
    integrityOk = integrity === "ok";
  } catch (err) {
    integrity = `error: ${(err as Error).message}`;
  }
  const dbPath = process.env.DB_PATH ?? "./data/opengravity.db";
  const dbFileOk = fs.existsSync(dbPath);
  const nvidiaOk = !!(process.env.NVIDIA_API_KEY ?? "").trim();

  sections.push(sectionFrom("SYSTEM", [
    { name: "node >= 20", ok: nodeMajor >= 20, detail: `node ${process.versions.node}` },
    { name: "sqlite abre + integrity_check", ok: integrityOk, detail: `PRAGMA integrity_check: ${integrity}` },
    { name: "DB_PATH existe", ok: dbFileOk, detail: `${path.resolve(dbPath)} ${dbFileOk ? "encontrado" : "NO existe (se creará al abrir)"}` },
    { name: "NVIDIA_API_KEY presente", ok: nvidiaOk, detail: nvidiaOk ? "configurada (valor NO mostrado)" : "AUSENTE — el cerebro LLM no podrá responder" },
  ]));

  // ── 2. MARKET_DATA ────────────────────────────────────────
  // Demo-first: bridge caído = WARN (el sistema sigue siendo honesto),
  // no FAIL — el trading real exige bridge, pero el doctor mide salud.
  const alive = await bridgeHealthQuick();
  const mdChecks: DoctorCheck[] = [];
  if (!alive) {
    mdChecks.push({
      name: "bridge MT5 health",
      ok: false,
      severity: "warn",
      detail: `bridge no responde en ${process.env.MT5_BRIDGE_URL ?? "http://localhost:5001"} (timeout 2.5s) — análisis fail-closed y sin ejecución`,
    });
  } else {
    mdChecks.push({ name: "bridge MT5 health", ok: true, detail: "health OK" });
    const symbol = (process.env.DOCTOR_SYMBOL ?? "US30").toUpperCase();
    try {
      const candles = await MT5Bridge.getCandles(symbol, "M5", 3);
      const age = lastCandleAgeMinutes(candles);
      if (age === null) {
        mdChecks.push({ name: "frescura de velas", ok: false, severity: "warn", detail: `última vela ${symbol} M5 con timestamp ilegible` });
      } else if (age > 30) {
        mdChecks.push({ name: "frescura de velas", ok: false, severity: "warn", detail: `última vela ${symbol} M5 tiene ${Math.round(age)} min (umbral 30) — mercado cerrado o feed estancado` });
      } else {
        mdChecks.push({ name: "frescura de velas", ok: true, detail: `última vela ${symbol} M5: ${Math.max(0, Math.round(age))} min (< 30)` });
      }
    } catch (err) {
      mdChecks.push({ name: "frescura de velas", ok: false, severity: "warn", detail: `getCandles falló: ${(err as Error).message}` });
    }
  }
  sections.push(sectionFrom("MARKET_DATA", mdChecks));

  // ── 3. STRATEGY ───────────────────────────────────────────
  // smc_detector importable y respondiendo a velas sintéticas: se prueba a
  // través de analyzeLiveStructure (que es su consumidor real en vivo) para
  // no depender de los errores tsc conocidos de src/backtest/ (baseline).
  const stChecks: DoctorCheck[] = [];
  try {
    const analysis = await analyzeLiveStructure("DOCTOR", "M5", syntheticCandles(70));
    stChecks.push({
      name: "smc_detector responde",
      ok: analysis.available === true,
      detail: analysis.available
        ? `estructura derivada: trend=${analysis.trend}, swings=${analysis.swings.length}, shifts=${analysis.structureShifts.length}`
        : `fail-closed honesto: ${analysis.unavailableReason ?? "sin razón"}`,
    });
  } catch (err) {
    stChecks.push({ name: "smc_detector responde", ok: false, detail: `excepción: ${(err as Error).message}` });
  }
  const pendingSkills = getSkillsRegistry().filter((s) => s.status === "PENDING");
  stChecks.push({
    name: "skills PENDING",
    ok: true,
    detail: pendingSkills.length
      ? `${pendingSkills.length} skill(es) declaradas PENDING honestamente: ${pendingSkills.map((s) => s.identity).join(", ")}`
      : "0 skills PENDING",
  });
  sections.push(sectionFrom("STRATEGY", stChecks));

  // ── 4. RISK ───────────────────────────────────────────────
  const limits = getRiskLimits();
  const limitsOk =
    Number.isFinite(limits.maxDailyLossPct) && limits.maxDailyLossPct > 0 &&
    Number.isFinite(limits.maxOpenPositions) && limits.maxOpenPositions > 0 &&
    Number.isFinite(limits.maxConsecutiveLosses) && limits.maxConsecutiveLosses > 0 &&
    Number.isFinite(limits.maxTotalExposureLots) && limits.maxTotalExposureLots > 0;
  const riskChecks: DoctorCheck[] = [
    {
      name: "límites por env legibles",
      ok: limitsOk,
      detail: `MAX_DAILY_LOSS_PCT=${limits.maxDailyLossPct} MAX_OPEN_POSITIONS=${limits.maxOpenPositions} MAX_CONSECUTIVE_LOSSES=${limits.maxConsecutiveLosses} MAX_TOTAL_EXPOSURE_LOTS=${limits.maxTotalExposureLots}`,
    },
  ];
  const pv = computePipValueUSD("US30", 1, null);
  riskChecks.push({
    name: "tabla PIP_VALUE no vacía",
    ok: pv !== null,
    detail: pv ? `pip value US30 = $${pv.value}/pip/lote (fuente: ${pv.source})` : "tabla vacía o símbolo base ausente — símbolos sin symbol_info serán rechazados",
  });
  if (alive) {
    try {
      const risk = await getAccountRisk();
      riskChecks.push({
        name: "snapshot getAccountRisk",
        ok: risk.evaluated && risk.ok,
        severity: risk.evaluated && risk.ok ? undefined : "warn",
        detail: risk.evaluated
          ? risk.ok
            ? `cuenta OK (balance ${risk.details.balance}, posiciones ${risk.details.openPositions}, PnL hoy ${risk.details.dailyPnl})`
            : `violaciones: ${risk.violations.join(" · ")}`
          : `cuenta ilegible (fail-closed): ${risk.violations.join(" · ")}`,
      });
    } catch (err) {
      riskChecks.push({ name: "snapshot getAccountRisk", ok: false, severity: "warn", detail: `excepción: ${(err as Error).message}` });
    }
  } else {
    riskChecks.push({ name: "snapshot getAccountRisk", ok: false, severity: "warn", detail: "bridge caído — riesgo de cuenta no evaluable ahora (fail-closed)" });
  }
  sections.push(sectionFrom("RISK", riskChecks));

  // ── 5. EXECUTION ──────────────────────────────────────────
  let orphanOrders = -1;
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM trade_orders WHERE status = 'placed' AND ticket IS NULL`)
      .get() as { n: number };
    orphanOrders = Number(row.n) || 0;
  } catch {
    orphanOrders = -1;
  }
  const policy = getPolicySummary();
  sections.push(sectionFrom("EXECUTION", [
    {
      name: "órdenes 'placed' sin ticket (reconciliación pendiente)",
      ok: orphanOrders === 0,
      severity: orphanOrders > 0 ? "warn" : undefined,
      detail: orphanOrders < 0
        ? "no se pudo consultar trade_orders"
        : orphanOrders === 0
          ? "0 órdenes colocadas sin confirmar ticket"
          : `${orphanOrders} orden(es) sin ticket: requiere reconciliación con el broker`,
    },
    {
      name: "policy summary",
      ok: true,
      detail: `modo=${policy.mode} · nivel=${policy.autonomyLevel} (efectivo L${policy.effectiveLevel}, techo=${policy.autonomyCeiling}) · kill_switch=${policy.killSwitch ? "ON" : "off"} · LIVE_TRADING env=${policy.liveTradingEnv}`,
    },
  ]));

  // ── 6. SECURITY ───────────────────────────────────────────
  const token = (process.env.DASHBOARD_TOKEN ?? "").trim();
  const live = isLiveMode();
  const secChecks: DoctorCheck[] = [
    {
      name: "DASHBOARD_TOKEN",
      ok: live ? !!token : true,
      severity: !live && !token ? "warn" : undefined,
      detail: token
        ? "configurado (valor NO mostrado)"
        : live
          ? "AUSENTE en modo LIVE — el dashboard/API quedaría abierto: FAIL §11"
          : "sin token (tolerable solo en modo demo local)",
    },
    {
      name: "ALLOWED_IDS",
      ok: !!(process.env.ALLOWED_IDS ?? "").trim() || !live,
      severity: !(process.env.ALLOWED_IDS ?? "").trim() ? "warn" : undefined,
      detail: (process.env.ALLOWED_IDS ?? "").trim()
        ? `whitelist Telegram configurada (${process.env.ALLOWED_IDS!.split(",").filter(Boolean).length} id(s))`
        : "vacía — Telegram queda fail-closed (nadie puede comandar), visible como advertencia",
    },
  ];
  try {
    const newsSrc = path.resolve("src/agent/tools/check_news.ts");
    const content = fs.existsSync(newsSrc) ? fs.readFileSync(newsSrc, "utf8") : "";
    const leaked = content.includes("tvly-");
    secChecks.push({
      name: "sin secretos 'tvly-' en check_news.ts",
      ok: !leaked,
      detail: leaked
        ? "POSIBLE API KEY de Tavily hardcodeada en el árbol — FAIL §23 (rotar y purgar historia)"
        : "limpio: sin claves hardcodeadas en el código",
    });
  } catch (err) {
    secChecks.push({ name: "sin secretos 'tvly-' en check_news.ts", ok: false, severity: "warn", detail: `no se pudo escanear: ${(err as Error).message}` });
  }
  sections.push(sectionFrom("SECURITY", secChecks));

  // ── 7. MEMORY ─────────────────────────────────────────────
  const memChecks: DoctorCheck[] = [];
  try {
    const counts = db
      .prepare(
        `SELECT
           SUM(CASE WHEN validation_status = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN validation_status = 'verified' THEN 1 ELSE 0 END) AS verified,
           SUM(CASE WHEN promoted = 1 THEN 1 ELSE 0 END) AS promoted,
           COUNT(*) AS total
         FROM agent_lessons`
      )
      .get() as { pending: number | null; verified: number | null; promoted: number | null; total: number | null };
    memChecks.push({
      name: "conteo de lecciones",
      ok: true,
      detail: `total=${counts.total ?? 0} · pending=${counts.pending ?? 0} · verified=${counts.verified ?? 0} · promoted=${counts.promoted ?? 0}`,
    });
  } catch (err) {
    memChecks.push({ name: "conteo de lecciones", ok: false, detail: `error consultando agent_lessons: ${(err as Error).message}` });
  }
  try {
    const row = db
      .prepare(`SELECT value, updated_at FROM memory_fragments WHERE user_id = 'system' AND key = 'last_consolidation'`)
      .get() as { value: string; updated_at: string } | undefined;
    if (!row) {
      memChecks.push({ name: "consolidación de memoria", ok: false, severity: "warn", detail: "consolidateMemory nunca ha corrido (arranca con el bucle de settlement)" });
    } else {
      const ageH = (Date.now() - Date.parse(row.value)) / 3_600_000;
      memChecks.push({
        name: "consolidación de memoria",
        ok: Number.isFinite(ageH) && ageH <= 24,
        severity: "warn",
        detail: Number.isFinite(ageH)
          ? `última consolidación hace ${ageH < 1 ? `${Math.round(ageH * 60)} min` : `${Math.round(ageH)} h`}${ageH > 24 ? " (umbral 24h)" : ""}`
          : `timestamp ilegible en memory_fragments: ${row.value}`,
      });
    }
  } catch (err) {
    memChecks.push({ name: "consolidación de memoria", ok: false, severity: "warn", detail: `error consultando memory_fragments: ${(err as Error).message}` });
  }
  sections.push(sectionFrom("MEMORY", memChecks));

  // ── 8. SKILLS ─────────────────────────────────────────────
  const skills = getSkillsRegistry();
  const identities = new Set(skills.map((s) => s.identity));
  const skillsOk = skills.length === 17 && identities.size === skills.length && skills.every((s) => !!s.version);
  sections.push(sectionFrom("SKILLS", [
    {
      name: "registry completo y consistente",
      ok: skillsOk,
      detail: `${skills.length} skills (${identities.size} identidades únicas) · ACTIVE=${skills.filter((s) => s.status === "ACTIVE").length} · PENDING=${skills.filter((s) => s.status === "PENDING").length}`,
    },
    {
      name: "versiones declaradas",
      ok: skills.every((s) => /^\d+\.\d+\.\d+$/.test(s.version)),
      detail: `versiones semánticas presentes (${[...new Set(skills.map((s) => s.version))].join(", ")})`,
    },
  ]));

  // ── 9. TESTING ────────────────────────────────────────────
  const testFiles = ["tests/smoke_phases.ts", "tests/risk_smc.test.ts", "tests/memory_skills.test.ts"];
  const testChecks: DoctorCheck[] = testFiles.map((f) => {
    let ok = false;
    let detail = `${f}: no existe`;
    try {
      if (fs.existsSync(f)) {
        const st = fs.statSync(f);
        const days = (Date.now() - st.mtimeMs) / 86_400_000;
        ok = true;
        detail = `${f}: existe, última modificación hace ${days < 1 ? `${Math.round(days * 24)} h` : `${Math.round(days)} d`} (${st.mtime.toISOString().slice(0, 10)})`;
      }
    } catch (err) {
      detail = `${f}: error al inspeccionar: ${(err as Error).message}`;
    }
    return { name: `suite ${path.basename(f)}`, ok, detail };
  });
  testChecks.push({
    name: "smoke_phases ejecutable",
    ok: fs.existsSync("tests/smoke_phases.ts"),
    detail: "el doctor solo verifica existencia y fecha (correrlo: npm test / tsx tests/smoke_phases.ts)",
  });
  sections.push(sectionFrom("TESTING", testChecks));

  // ── Score ─────────────────────────────────────────────────
  let points = 0;
  let total = 0;
  for (const s of sections) {
    for (const c of s.checks) {
      total++;
      points += c.ok ? 1 : c.severity === "warn" ? 0.5 : 0;
    }
  }
  const score = total > 0 ? Math.round((points / total) * 100) : 0;

  return { sections, score, generatedAt: new Date().toISOString() };
}

// ── Auto-repair determinista (documentado arriba) ──────────

export function runDoctorRepairs(): string[] {
  const done: string[] = [];
  try {
    db.pragma("optimize");
    done.push("PRAGMA optimize ejecutado");
  } catch (err) {
    done.push(`PRAGMA optimize falló: ${(err as Error).message}`);
  }
  try {
    const res = db
      .prepare(`DELETE FROM agent_errors WHERE resolved = 1 AND created_at <= datetime('now', '-30 days')`)
      .run();
    done.push(`agent_errors resueltos >30 días purgados: ${res.changes} fila(s)`);
  } catch (err) {
    done.push(`purga agent_errors falló: ${(err as Error).message}`);
  }
  try {
    const res = db
      .prepare(`UPDATE agent_lessons SET memory_type = 'SEMANTIC' WHERE memory_type IS NULL`)
      .run();
    done.push(`backfill memory_type NULL → 'SEMANTIC': ${res.changes} fila(s)`);
  } catch (err) {
    done.push(`backfill memory_type falló: ${(err as Error).message}`);
  }
  return done;
}

// ── Render para Telegram / dashboard ───────────────────────

function icon(verdict: "OK" | "WARN" | "FAIL"): string {
  return verdict === "OK" ? "✅" : verdict === "WARN" ? "🟡" : "🔴";
}

function checkIcon(c: DoctorCheck): string {
  return c.ok ? "  ✅" : c.severity === "warn" ? "  🟡" : "  ❌";
}

export function renderDoctorMarkdown(report: DoctorReport): string {
  const lines: string[] = [
    `### 🩺 Doctor del agente — score **${report.score}/100**`,
    `_generado: ${report.generatedAt}_`,
    "",
  ];
  for (const s of report.sections) {
    lines.push(`${icon(s.verdict)} **${s.name}**`);
    for (const c of s.checks) {
      lines.push(`${checkIcon(c)} ${c.name}: ${c.detail}`);
    }
    lines.push("");
  }
  const fails = report.sections.filter((s) => s.verdict === "FAIL");
  const warns = report.sections.filter((s) => s.verdict === "WARN");
  lines.push(
    fails.length
      ? `🔴 FAIL: ${fails.map((s) => s.name).join(", ")}`
      : warns.length
        ? `🟡 WARN: ${warns.map((s) => s.name).join(", ")}`
        : "✅ Todas las secciones OK"
  );
  lines.push("_Auto-repair disponible (determinista, nunca toca estrategia): PRAGMA optimize · purga agent_errors resueltos >30d · backfill memory_type._");
  return lines.join("\n");
}
