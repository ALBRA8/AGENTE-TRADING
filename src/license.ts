// ============================================================
// src/license.ts
// Licencia OFFLINE HMAC-SHA256 (sin servidor de licencias, sin dependencias).
//
// Formato de la key:
//   base64url(payloadJSON) + "." + base64url(hmacSHA256(payloadB64, secret))
//   payload = { product: "AGENTE-TRADING", email, expiryISO }
//
// Comportamiento por env (diseño anti-hostage):
//   - LICENSE_REQUIRED=false (default): si la licencia falta o es inválida
//     SOLO se registra un WARN — jamás se bloquea al dueño actual.
//   - LICENSE_REQUIRED=true: una licencia inválida/ausente bloquea /api/*
//     (el server.ts deja pasar /api/trackrecord y /api/health).
//
// Mini-CLI (ejecutar con node --import tsx src/license.ts):
//   src/license.ts generate <email> <días>   → imprime la key
//   src/license.ts validate <key> [secret]   → imprime el resultado JSON
// ============================================================

import { createHmac, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

export const LICENSE_PRODUCT = "AGENTE-TRADING";
const DAY_MS = 86_400_000;

// ── Tipos ───────────────────────────────────────────────────
export interface LicensePayload {
  product: string;
  email: string;
  expiryISO: string;
}

export interface LicenseValidation {
  valid: boolean;
  reason?:
    | "formato_invalido"
    | "firma_invalida"
    | "payload_ilegible"
    | "producto_incorrecto"
    | "expiracion_ilegible"
    | "expirada"
    | "sin_secreto";
  email?: string;
  expiryISO?: string;
  daysLeft?: number;
}

export interface LicenseState {
  required: boolean;
  secretConfigured: boolean;
  keyPresent: boolean;
  validation: LicenseValidation;
}

// ── Codificación ────────────────────────────────────────────
function b64urlEncode(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function b64urlDecode(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

function signPayload(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Generación ──────────────────────────────────────────────
/**
 * Genera una licencia firmada. `days` puede ser negativo (útil para tests:
 * produce una key ya expirada). Lanza si falta el secreto o el email es
 * inválido — generar sin secreto sería firmar con una key vacía.
 */
export function generateLicenseKey(
  email: string,
  days: number,
  secret: string = process.env.LICENSE_SECRET ?? ""
): string {
  if (!secret) {
    throw new Error(
      "LICENSE_SECRET no definido: exporta LICENSE_SECRET antes de generar licencias."
    );
  }
  if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
    throw new Error(`Email inválido para la licencia: "${email}"`);
  }
  if (!Number.isFinite(days) || days === 0) {
    throw new Error(`Duración inválida (días): ${days}`);
  }
  const payload: LicensePayload = {
    product: LICENSE_PRODUCT,
    email: email.trim().toLowerCase(),
    expiryISO: new Date(Date.now() + days * DAY_MS).toISOString(),
  };
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  return `${payloadB64}.${signPayload(payloadB64, secret)}`;
}

// ── Validación ──────────────────────────────────────────────
/**
 * Valida firma + formato + producto + expiración. NUNCA lanza:
 * cualquier anomalía devuelve { valid: false, reason }.
 */
export function validateLicense(
  key: string,
  secret: string = process.env.LICENSE_SECRET ?? ""
): LicenseValidation {
  if (!secret) return { valid: false, reason: "sin_secreto" };
  if (typeof key !== "string") return { valid: false, reason: "formato_invalido" };

  const parts = key.trim().split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { valid: false, reason: "formato_invalido" };
  }
  const [payloadB64, sigB64] = parts;

  // Comparación en tiempo constante (evita oracular por timing)
  try {
    const expected = Buffer.from(signPayload(payloadB64, secret));
    const actual = Buffer.from(sigB64);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return { valid: false, reason: "firma_invalida" };
    }
  } catch {
    return { valid: false, reason: "formato_invalido" };
  }

  let payload: LicensePayload;
  try {
    const parsed = JSON.parse(b64urlDecode(payloadB64)) as Partial<LicensePayload>;
    if (
      !parsed ||
      typeof parsed.product !== "string" ||
      typeof parsed.email !== "string" ||
      typeof parsed.expiryISO !== "string"
    ) {
      return { valid: false, reason: "payload_ilegible" };
    }
    payload = parsed as LicensePayload;
  } catch {
    return { valid: false, reason: "payload_ilegible" };
  }

  if (payload.product !== LICENSE_PRODUCT) {
    return {
      valid: false,
      reason: "producto_incorrecto",
      email: payload.email,
      expiryISO: payload.expiryISO,
    };
  }

  const expiry = Date.parse(payload.expiryISO);
  if (!Number.isFinite(expiry)) {
    return {
      valid: false,
      reason: "expiracion_ilegible",
      email: payload.email,
      expiryISO: payload.expiryISO,
    };
  }

  const daysLeft = Math.floor((expiry - Date.now()) / DAY_MS);
  if (expiry <= Date.now()) {
    return {
      valid: false,
      reason: "expirada",
      email: payload.email,
      expiryISO: payload.expiryISO,
      daysLeft,
    };
  }

  return {
    valid: true,
    email: payload.email,
    expiryISO: payload.expiryISO,
    daysLeft,
  };
}

// ── Estado desde env (lo consume server.ts) ─────────────────
/**
 * Lee LICENSE_REQUIRED / LICENSE_SECRET / LICENSE_KEY y evalúa.
 * Por defecto (LICENSE_REQUIRED!=true) NUNCA bloquea: solo informa.
 */
export function evaluateLicenseEnv(): LicenseState {
  const required = (process.env.LICENSE_REQUIRED ?? "false").trim().toLowerCase() === "true";
  const secretConfigured = Boolean(process.env.LICENSE_SECRET);
  const key = process.env.LICENSE_KEY ?? "";
  const keyPresent = Boolean(key.trim());
  const validation = validateLicense(key);
  return { required, secretConfigured, keyPresent, validation };
}

/**
 * Decisión de bloqueo para el server: SOLO bloquea si LICENSE_REQUIRED=true
 * y la licencia no es válida. Nunca bloquea al dueño actual por defecto.
 */
export function getLicenseGate(): { blocking: boolean; state: LicenseState } {
  const state = evaluateLicenseEnv();
  return { blocking: state.required && !state.validation.valid, state };
}

/** Línea de log del arranque (server.ts). Tono honesto, sin PII sensible. */
export function renderLicenseLogLine(state: LicenseState): string {
  const v = state.validation;
  if (!state.required) {
    if (!state.keyPresent) {
      return "[Licencia] ⚠️  Sin licencia configurada (LICENSE_REQUIRED=false) → operativo igualmente.";
    }
    return v.valid
      ? `[Licencia] ✅ Válida (${v.email}, expira en ${v.daysLeft} día(s)) · no requerida.`
      : `[Licencia] ⚠️  Presente pero inválida (${v.reason}) · LICENSE_REQUIRED=false → operativo igualmente.`;
  }
  return v.valid
    ? `[Licencia] ✅ Válida (${v.email}, expira en ${v.daysLeft} día(s)).`
    : `[Licencia] 🚫 Requerida e INVÁLIDA (${v.reason}) → /api/* responde 503 salvo /api/trackrecord y /api/health.`;
}

// ── Mini-CLI (solo si este archivo ES el punto de entrada) ──
function runCli(): number {
  const cmd = process.argv[2];
  const secret = process.env.LICENSE_SECRET ?? "";

  if (cmd === "generate") {
    const email = process.argv[3] ?? "";
    const days = parseInt(process.argv[4] ?? "365", 10);
    try {
      const key = generateLicenseKey(email, Number.isFinite(days) ? days : NaN, secret);
      console.log(key);
      return 0;
    } catch (err) {
      console.error(`❌ ${(err as Error).message}`);
      console.error("Uso: node --import tsx src/license.ts generate <email> <días>   (con LICENSE_SECRET exportado)");
      return 1;
    }
  }

  if (cmd === "validate") {
    const key = process.argv[3] ?? "";
    const cliSecret = process.argv[4] ?? secret;
    const result = validateLicense(key, cliSecret);
    console.log(JSON.stringify(result, null, 2));
    return result.valid ? 0 : 1;
  }

  console.log(
    [
      "AGENTE-TRADING · Licencia offline (HMAC-SHA256)",
      "",
      "Uso:",
      "  node --import tsx src/license.ts generate <email> <días>   # requiere LICENSE_SECRET",
      "  node --import tsx src/license.ts validate <key> [secret]",
    ].join("\n")
  );
  return cmd ? 1 : 0;
}

// Ejecuta la CLI solo cuando el proceso arranca DESDE este archivo
// (importarlo desde server.ts o los tests no dispara nada).
const invokedDirectly =
  process.argv[1] &&
  (() => {
    try {
      return pathToFileURL(process.argv[1]).href === import.meta.url;
    } catch {
      return false;
    }
  })();

if (invokedDirectly) {
  process.exitCode = runCli();
}
