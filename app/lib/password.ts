const encoder = new TextEncoder()
// The pinned Workers runtime caps WebCrypto PBKDF2 at 100,000 iterations.
// Store parameters in each hash so future runtime/KDF upgrades remain possible.
const ITERATIONS = 100_000
const PREFIX = "pbkdf2-sha256"

function encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
}

async function equal(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (left: BufferSource, right: BufferSource) => boolean
  }
  if (subtle.timingSafeEqual) return subtle.timingSafeEqual(a, b)
  // Next.js local development uses standard WebCrypto without the Workers
  // extension. HMAC verification keeps comparison inside the crypto runtime.
  const key = await subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"])
  const signature = await subtle.sign("HMAC", key, a)
  return subtle.verify("HMAC", key, signature, b)
}

async function derive(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"])
  return new Uint8Array(await crypto.subtle.deriveBits({
    name: "PBKDF2", hash: "SHA-256", salt, iterations,
  }, key, 256))
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return `${PREFIX}$${ITERATIONS}$${encode(salt)}$${encode(await derive(password, salt, ITERATIONS))}`
}

export function needsPasswordUpgrade(hash: string | null) {
  return !!hash && !hash.startsWith(`${PREFIX}$`)
}

export async function comparePassword(password: string, hash: string | null) {
  if (!hash) return false
  try {
    if (hash.startsWith(`${PREFIX}$`)) {
      const parts = hash.split("$")
      const iterations = Number(parts[1])
      if (parts.length !== 4 || iterations !== ITERATIONS) return false
      const salt = Uint8Array.from(atob(parts[2]), c => c.charCodeAt(0))
      const expected = Uint8Array.from(atob(parts[3]), c => c.charCodeAt(0))
      if (salt.length !== 16 || expected.length !== 32) return false
      return equal(await derive(password, salt, iterations), expected)
    }
    // Keep the old secret during migration; new hashes do not use AUTH_SECRET.
    const secret = process.env.LEGACY_PASSWORD_SECRET || process.env.AUTH_SECRET
    if (!secret) return false
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(password + secret))
    return equal(encoder.encode(encode(new Uint8Array(digest))), encoder.encode(hash))
  } catch {
    return false
  }
}
