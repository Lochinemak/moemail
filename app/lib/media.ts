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
  const raw = (value || "").trim().replace(/^cid:/i, "").replace(/^<|>$/g, "")
  try {
    return decodeURIComponent(raw).toLowerCase()
  } catch {
    return raw.toLowerCase()
  }
}

export const SAFE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

export function detectImageType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return "image/png"
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg"
  const prefix = String.fromCharCode(...bytes.slice(0, 12))
  if (prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a")) return "image/gif"
  if (prefix.startsWith("RIFF") && prefix.slice(8) === "WEBP") return "image/webp"
  return null
}

export async function rewriteCidImages(html: string, urls: Map<string, string>) {
  return new HTMLRewriter().on("img", {
    element(element) {
      const src = element.getAttribute("src")
      if (!src || !/^cid:/i.test(src)) return
      const url = urls.get(normalizeContentId(src))
      if (url) element.setAttribute("src", url)
    },
  }).transform(new Response(html)).text()
}

export function mediaResponseHeaders(contentType: string, size: number) {
  return new Headers({
    "Content-Type": contentType,
    "Content-Length": String(size),
    "Content-Disposition": "inline",
    "Cache-Control": "private, no-store",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  })
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
