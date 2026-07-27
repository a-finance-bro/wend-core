/**
 * Application-level encryption for secrets at rest (ASVS V6 / V2.10) — used for
 * stored Google OAuth refresh tokens in calendar_connections + gmail_connections.
 *
 * AES-256-GCM with a key from the WEND_ENCRYPTION_KEY env var (32 bytes, base64
 * or hex). Authenticated (GCM tag) so tampering is detected.
 *
 * SAFE ROLLOUT — two properties make this deployable before the key is set and
 * before existing rows are migrated:
 *   1. encryptSecret() is a NO-OP passthrough when no key is configured, so
 *      deploying this code changes nothing until WEND_ENCRYPTION_KEY is added.
 *   2. decryptSecret() is dual-read: a value WITHOUT the "encv1:" prefix is
 *      treated as legacy plaintext and returned as-is. So new writes encrypt,
 *      old rows keep working, and a one-off backfill can migrate them lazily.
 *
 * Generate a key: `openssl rand -base64 32`. Set it in Vercel (both regions
 * share app env) — do NOT commit it.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "encv1:"; // marks an app-encrypted value; legacy plaintext lacks it

function loadKey(): Buffer | null {
  const raw = process.env.WEND_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  let k = Buffer.from(raw, "base64");
  if (k.length !== 32) k = Buffer.from(raw, "hex");
  return k.length === 32 ? k : null;
}

/** True when a valid 32-byte key is configured (encryption active). */
export function isEncryptionConfigured(): boolean {
  return loadKey() !== null;
}

/** Encrypt a secret for storage. No key configured → returns plaintext (no-op),
 *  so this is safe to ship before the key + backfill are in place. */
export function encryptSecret(plaintext: string | null | undefined): string | null {
  if (plaintext == null || plaintext === "") return plaintext ?? null;
  const k = loadKey();
  if (!k) return plaintext; // passthrough until a key is set
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

/** Decrypt a stored secret. Legacy plaintext (no prefix) is returned as-is. */
export function decryptSecret(stored: string | null | undefined): string {
  if (!stored) return "";
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext
  const k = loadKey();
  if (!k) {
    // Encrypted value but no key — can't recover. Return as-is so the failure
    // surfaces upstream (the token won't work) rather than silently misbehaving.
    return stored;
  }
  const raw = Buffer.from(stored.slice(PREFIX.length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", k, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
