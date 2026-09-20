import { getRequestContext } from "@cloudflare/next-on-pages"
import { drizzle } from "drizzle-orm/d1"
import { and, eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { emails, messageAttachments, messages } from "@/lib/schema"
import { verifyMediaSignature } from "@/lib/media"

export const runtime = "edge"

function timestamp(value: Date | number): number {
  return value instanceof Date ? value.getTime() : Number(value)
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ messageId: string; attachmentId: string }> }
) {
  const { messageId, attachmentId } = await params
  const url = new URL(request.url)
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
    const db = drizzle(env.DB, { schema: { emails, messages, messageAttachments } })
    const attachment = await db.query.messageAttachments.findFirst({
    where: and(eq(messageAttachments.id, attachmentId), eq(messageAttachments.messageId, messageId)),
    })
    if (!attachment || timestamp(attachment.expiresAt) < Date.now()) {
      return new NextResponse("Gone", { status: 410 })
    }

    const message = await db.query.messages.findFirst({ where: eq(messages.id, messageId) })
    if (!message) return new NextResponse("Not found", { status: 404 })
    const email = await db.query.emails.findFirst({ where: eq(emails.id, message.emailId) })
    if (!email || timestamp(email.expiresAt) < Date.now()) return new NextResponse("Gone", { status: 410 })

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
