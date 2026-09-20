const encoder = new TextEncoder()

function toBase64Url(bytes: ArrayBuffer): string {
  const value = String.fromCharCode(...new Uint8Array(bytes))
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return toBase64Url(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)))
}

export async function createMediaSignature(secret: string, messageId: string, attachmentId: string, exp: number) {
  return sign(secret, messageId + ":" + attachmentId + ":" + exp)
}

export async function verifyMediaSignature(secret: string, messageId: string, attachmentId: string, exp: number, signature: string) {
  if (!secret || !Number.isSafeInteger(exp) || exp < Math.floor(Date.now() / 1000)) return false
  const expected = await createMediaSignature(secret, messageId, attachmentId, exp)
  const a = encoder.encode(expected)
  const b = encoder.encode(signature)
  let diff = a.length ^ b.length
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i++) diff |= (a[i] || 0) ^ (b[i] || 0)
  return diff === 0
}

export function normalizeContentId(value: string | undefined | null): string {
  return decodeURIComponent((value || "").trim().replace(/^cid:/i, "").replace(/^<|>$/g, "")).toLowerCase()
}

export function mediaUrl(base: string, messageId: string, attachmentId: string, exp: number, signature: string) {
  return base.replace(/\/$/, "") + "/api/media/" + encodeURIComponent(messageId) + "/" + encodeURIComponent(attachmentId) + "?exp=" + exp + "&sig=" + encodeURIComponent(signature)
}

export function sanitizeEmailHtml(html: string): string {
  return html
    .replace(/<\/?(script|iframe|object|embed|form|base)(?:\s[^>]*)?>/gi, "")
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, " $1=$2#$2")
}
