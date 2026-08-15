import crypto from "node:crypto";

// AES-256-GCM for OAuth refresh tokens at rest, plus HMAC for signing the
// OAuth `state` parameter. Server-only — never import from a client component.

const ALGO = "aes-256-gcm";

function masterKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is not set. Generate one with: openssl rand -base64 32"
    );
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to 32 bytes (got ${buf.length}). Generate one with: openssl rand -base64 32`
    );
  }
  return buf;
}

/** Encrypts to "v1:<iv>:<tag>:<ciphertext>", each part base64. */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ct.toString("base64"),
  ].join(":");
}

export function decryptSecret(payload: string): string {
  const [version, ivB64, tagB64, ctB64] = payload.split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !ctB64) {
    throw new Error("Malformed ciphertext");
  }
  const decipher = crypto.createDecipheriv(
    ALGO,
    masterKey(),
    Buffer.from(ivB64, "base64")
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

// ---------- Signed payloads ----------
// Each purpose derives its own key, so a signature minted for one context can
// never be replayed in another — an OAuth state can't stand in for a reminder
// link, even though both come from TOKEN_ENCRYPTION_KEY.
function purposeKey(purpose: string): Buffer {
  return crypto.createHmac("sha256", masterKey()).update(purpose).digest();
}

function stateKey(): Buffer {
  return purposeKey("oauth-state");
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function signState(payload: Record<string, unknown>): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const mac = b64url(crypto.createHmac("sha256", stateKey()).update(body).digest());
  return `${body}.${mac}`;
}

export function verifyState<T = Record<string, unknown>>(state: string): T | null {
  const [body, mac] = state.split(".");
  if (!body || !mac) return null;
  const expected = crypto.createHmac("sha256", stateKey()).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  // timingSafeEqual throws on length mismatch — check first.
  if (given.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(given, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

export function randomNonce(): string {
  return crypto.randomBytes(16).toString("base64url");
}


/** Signs an arbitrary payload under a named purpose. */
export function signPayload(
  purpose: string,
  payload: Record<string, unknown>
): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const mac = b64url(
    crypto.createHmac("sha256", purposeKey(purpose)).update(body).digest()
  );
  return `${body}.${mac}`;
}

export function verifyPayload<T = Record<string, unknown>>(
  purpose: string,
  token: string
): T | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;

  const expected = crypto
    .createHmac("sha256", purposeKey(purpose))
    .update(body)
    .digest();
  let given: Buffer;
  try {
    given = Buffer.from(mac, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(given, expected)) return null;

  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}
