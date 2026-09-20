interface Env {
  DB: D1Database
  EMAIL_ASSETS: R2Bucket
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const match = url.pathname.match(/^\/api\/media\/([^/]+)\/([^/]+)$/)
    if (request.method !== "GET" || !match) return new Response("Not found", { status: 404 })
    const messageId = decodeURIComponent(match[1])
    const attachmentId = decodeURIComponent(match[2])
    const exp = Number(url.searchParams.get("exp"))
    const signature = url.searchParams.get("sig") || ""
    if (!Number.isSafeInteger(exp) || exp < Math.floor(Date.now() / 1000) || !signature) {
      return new Response("Not found", { status: 404 })
    }
    try {
      const attachment = await env.DB.prepare(
        "SELECT ma.object_key AS objectKey, ma.content_type AS contentType, " +
        "ma.size AS size, ma.expires_at AS attachmentExpiresAt, " +
        "e.expires_at AS emailExpiresAt FROM message_attachment ma " +
        "JOIN message m ON m.id = ma.message_id JOIN email e ON e.id = m.emailId " +
        "WHERE ma.id = ? AND ma.message_id = ? AND ma.media_token = ? " +
        "AND ma.expires_at = ? LIMIT 1"
      ).bind(attachmentId, messageId, signature, exp * 1000).first<{
        objectKey: string
        contentType: string
        size: number
        attachmentExpiresAt: number
        emailExpiresAt: number
      }>()
      if (!attachment || attachment.attachmentExpiresAt < Date.now() || attachment.emailExpiresAt < Date.now()) {
        return new Response("Gone", { status: 410 })
      }
      const object = await env.EMAIL_ASSETS.get(attachment.objectKey)
      if (!object) return new Response("Not found", { status: 404 })
      const headers = new Headers({
        "Content-Type": attachment.contentType,
        "Content-Length": String(attachment.size),
        "Content-Disposition": "inline",
        "Cache-Control": "public, max-age=86400, immutable",
        "X-Content-Type-Options": "nosniff",
      })
      if (object.httpEtag) headers.set("ETag", object.httpEtag)
      return new Response(object.body, { headers })
    } catch (error) {
      console.error("Failed to serve email media:", error)
      return new Response("Internal server error", { status: 500 })
    }
  },
}
