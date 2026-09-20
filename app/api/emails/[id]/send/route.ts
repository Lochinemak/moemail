import { NextResponse } from "next/server"
import { getUserId } from "@/lib/apiKey"
import { createDb } from "@/lib/db"
import { emails } from "@/lib/schema"
import { and, eq, gt } from "drizzle-orm"
import { getRequestContext } from "@cloudflare/next-on-pages"
import { checkBasicSendPermission, getUserDailyLimit } from "@/lib/send-permissions"
import { completeSend, countSends, reserveSend } from "@/lib/send-requests"
import { z } from "zod"

export const runtime = "edge"

const sendSchema = z.object({
  to: z.string().email().max(254),
  subject: z.string().trim().min(1).max(998),
  content: z.string().min(1).max(1_000_000),
})

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestKey = request.headers.get("Idempotency-Key")
  if (!requestKey || !/^[a-zA-Z0-9_-]{8,128}$/.test(requestKey)) {
    return NextResponse.json({ error: "A valid Idempotency-Key header is required" }, { status: 400 })
  }
  const reply = (body: object, status = 200) => NextResponse.json(
    { ...body, idempotencyKey: requestKey }, { status, headers: { "Cache-Control": "no-store" } }
  )

  try {
    const userId = await getUserId()
    if (!userId) return reply({ error: "Unauthorized" }, 401)
    const permission = await checkBasicSendPermission(userId)
    if (!permission.canSend) return reply({ error: permission.error }, 403)
    const body = sendSchema.safeParse(await request.json())
    if (!body.success) return reply({ error: "Invalid recipient, subject or content" }, 400)
    const { to, subject, content } = body.data
    const { id } = await params
    const env = getRequestContext().env
    const apiKey = await env.SITE_CONFIG.get("RESEND_API_KEY")
    if (!apiKey) return reply({ error: "Email service is not configured" }, 503)
    const limit = await getUserDailyLimit(userId)
    if (limit < 0) return reply({ error: "Permission denied" }, 403)
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest(
      "SHA-256", new TextEncoder().encode(JSON.stringify({ id, to, subject, content }))
    )), byte => byte.toString(16).padStart(2, "0")).join("")

    // Check the existing reservation before mailbox lookup: a completed retry
    // remains successful even after the user has deleted the sent message/mailbox.
    const existing = await env.DB.prepare(
      "SELECT payload_hash, status FROM send_request WHERE user_id = ? AND request_key = ?"
    ).bind(userId, requestKey).first<{ payload_hash: string; status: string }>()
    if (existing?.payload_hash && existing.payload_hash !== hash) return reply({ error: "Idempotency key was used for another message" }, 409)
    if (existing?.status === "sent") return reply({ success: true, remainingEmails: limit === 0 ? undefined : Math.max(0, limit - await countSends(env.DB, userId)) })
    if (existing?.status === "failed") return reply({ error: "This attempt was rejected; use a new key for a new attempt", retryWithNewKey: true }, 409)

    const email = await createDb().query.emails.findFirst({
      where: and(eq(emails.id, id), eq(emails.userId, userId), gt(emails.expiresAt, new Date())),
    })
    if (!email) return reply({ error: "Mailbox not found or expired" }, 404)
    const reservation = await reserveSend(env.DB, userId, requestKey, hash, limit)
    if (!reservation) return reply({ error: "Daily send limit reached", remainingEmails: 0 }, 429)
    if (reservation.payload_hash !== hash) return reply({ error: "Idempotency key was used for another message" }, 409)
    if (reservation.status === "failed") return reply({ error: "This attempt was rejected", retryWithNewKey: true }, 409)
    if (reservation.status !== "sent") {
      // Resend retains idempotency keys for 24h. Never resend an uncertain older
      // attempt after that window, even if a client reuses its key.
      if (Date.now() - reservation.created_at >= 23 * 60 * 60 * 1000) {
        return reply({ error: "Send outcome is unresolved; contact the administrator before retrying" }, 409)
      }
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Idempotency-Key": `moemail-${reservation.id}`,
        },
        body: JSON.stringify({ from: email.address, to: [to], subject, html: content }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) {
        // Definitive validation/auth failures release quota. Timeouts, conflicts,
        // throttling and server errors keep the reservation for a safe retry.
        if ([400, 401, 403, 404, 422].includes(response.status)) {
          await env.DB.prepare("UPDATE send_request SET status = 'failed' WHERE id = ? AND status = 'pending'")
            .bind(reservation.id).run()
          return reply({ error: "Email provider rejected the request; correct the request or service configuration before a new attempt", retryWithNewKey: true }, 502)
        }
        return reply({ error: "Email provider rejected the request; retry with the same key to check its outcome" }, 502)
      }
      const result = await response.json() as { id: string }
      if (!result.id) return reply({ error: "Email provider returned an unknown outcome; retry with the same key" }, 502)
      await completeSend(env.DB, { id: reservation.id, userId, emailId: email.id, to, subject, content, providerId: result.id })
    }
    return reply({ success: true, remainingEmails: limit === 0 ? undefined : Math.max(0, limit - await countSends(env.DB, userId)) })
  } catch {
    // Do not discard an uncertain reservation: the provider may already have sent.
    return reply({ error: "Unable to confirm delivery; retry with the same Idempotency-Key" }, 503)
  }
}
