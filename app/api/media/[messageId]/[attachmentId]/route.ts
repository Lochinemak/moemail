import { getRequestContext } from "@cloudflare/next-on-pages"
import { NextResponse } from "next/server"
import { verifyMediaSignature } from "@/lib/media"

export const runtime = "edge"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ messageId: string; attachmentId: string }> }
) {
  const { messageId, attachmentId } = await params
  const url = new URL(_request.url)
  const exp = Number(url.searchParams.get("exp"))
  const signature = url.searchParams.get("sig") || ""
  const env = getRequestContext().env

  if (!(await verifyMediaSignature(env.MEDIA_SIGNING_SECRET || "", messageId, attachmentId, exp, signature))) {
    return new NextResponse("Not found", { status: 404 })
  }
  if (!env.EMAIL_ASSETS) {
    console.error("EMAIL_ASSETS R2 binding is missing from the Pages deployment")
    return new NextResponse("Media storage unavailable", { status: 503 })
  }

  try {
    const attachment = await env.DB.prepare(
      "SELECT ma.object_key AS objectKey, ma.content_type AS contentType, " +
      "ma.size AS size, ma.expires_at AS attachmentExpiresAt, " +
      "e.expires_at AS emailExpiresAt FROM message_attachment ma " +
      "JOIN message m ON m.id = ma.message_id " +
      "JOIN email e ON e.id = m.emailId " +
      "WHERE ma.id = ? AND ma.message_id = ? LIMIT 1"
    ).bind(attachmentId, messageId).first<{
      objectKey: string
      contentType: string
      size: number
      attachmentExpiresAt: number
      emailExpiresAt: number
    }>()
    if (!attachment || attachment.attachmentExpiresAt < Date.now() || attachment.emailExpiresAt < Date.now()) {
      return new NextResponse("Gone", { status: 410 })
    }

    const object = await env.EMAIL_ASSETS.get(attachment.objectKey)
    if (!object) return new NextResponse("Not found", { status: 404 })

    const headers = new Headers()
    headers.set("Content-Type", attachment.contentType)
    headers.set("Content-Length", String(attachment.size))
    headers.set("Content-Disposition", "inline")
    headers.set("Cache-Control", "public, max-age=86400, immutable")
    headers.set("X-Content-Type-Options", "nosniff")
    if (object.httpEtag) headers.set("ETag", object.httpEtag)
    const response = new Response(object.body, { headers })
    return response
  } catch (error) {
    console.error("Failed to serve email media:", error)
    return new NextResponse("Internal server error", { status: 500 })
  }
}
