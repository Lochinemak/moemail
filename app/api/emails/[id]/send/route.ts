import { NextResponse } from "next/server"
import { getUserId } from "@/lib/apiKey"
import { createDb } from "@/lib/db"
import { emails } from "@/lib/schema"
import { and, eq, gt } from "drizzle-orm"
import { getRequestContext } from "@cloudflare/next-on-pages"
import { checkBasicSendPermission, getUserDailyLimit } from "@/lib/send-permissions"
import { claimProviderAttempt, completeSend, countSends, reserveSend } from "@/lib/send-requests"
import { getEmailDomain, getEmailProviderConfig, sendProviderEmail } from "@/lib/email-provider"
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
    const limit = await getUserDailyLimit(userId)
    if (limit < 0) return reply({ error: "Permission denied" }, 403)
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest(
      "SHA-256", new TextEncoder().encode(JSON.stringify({ id, to, subject, content }))
    )), byte => byte.toString(16).padStart(2, "0")).join("")

    const existing = await env.DB.prepare(
      "SELECT payload_hash, status, provider FROM send_request WHERE user_id = ? AND request_key = ?"
    ).bind(userId, requestKey).first<{ payload_hash: string; status: string; provider: "resend" | "mailgun" }>()
    if (existing?.payload_hash && existing.payload_hash !== hash) {
      return reply({ error: "Idempotency key was used for another message" }, 409)
    }
    if (existing?.status === "sent") {
      return reply({
        success: true,
        remainingEmails: limit === 0 ? undefined : Math.max(0, limit - await countSends(env.DB, userId)),
      })
    }
    if (existing?.status === "failed") {
      return reply({ error: "This attempt was rejected; use a new key for a new attempt", retryWithNewKey: true }, 409)
    }

    const email = await createDb().query.emails.findFirst({
      where: and(eq(emails.id, id), eq(emails.userId, userId), gt(emails.expiresAt, new Date())),
    })
    if (!email) return reply({ error: "Mailbox not found or expired" }, 404)

    const activeConfig = await getEmailProviderConfig(env.SITE_CONFIG)
    const selectedConfig = existing?.provider && existing.provider !== activeConfig.provider
      ? await getEmailProviderConfig(env.SITE_CONFIG, existing.provider)
      : activeConfig
    if (!selectedConfig.apiKey || (selectedConfig.provider === "mailgun" && !selectedConfig.domain)) {
      return reply({ error: "Email service is not configured" }, 503)
    }
    if (selectedConfig.provider === "mailgun" && getEmailDomain(email.address) !== selectedConfig.domain) {
      return reply({ error: `Sending is only available for @${selectedConfig.domain} mailboxes` }, 403)
    }

    const reservation = await reserveSend(env.DB, userId, requestKey, hash, limit, selectedConfig.provider)
    if (!reservation) return reply({ error: "Daily send limit reached", remainingEmails: 0 }, 429)
    if (reservation.payload_hash !== hash) return reply({ error: "Idempotency key was used for another message" }, 409)
    if (reservation.status === "failed") return reply({ error: "This attempt was rejected", retryWithNewKey: true }, 409)
    if (reservation.status !== "sent") {
      const providerConfig = reservation.provider === selectedConfig.provider
        ? selectedConfig
        : await getEmailProviderConfig(env.SITE_CONFIG, reservation.provider)
      if (!providerConfig.apiKey || (providerConfig.provider === "mailgun" && !providerConfig.domain)) {
        return reply({ error: "The reserved email provider is no longer configured" }, 503)
      }
      if (providerConfig.provider === "mailgun") {
        if (getEmailDomain(email.address) !== providerConfig.domain) {
          await env.DB.prepare("UPDATE send_request SET status = 'failed' WHERE id = ? AND status = 'pending'")
            .bind(reservation.id).run()
          return reply({ error: `Sending is only available for @${providerConfig.domain} mailboxes`, retryWithNewKey: true }, 403)
        }
        if (!await claimProviderAttempt(env.DB, reservation.id)) {
          return reply({ error: "Send outcome is unresolved; Mailgun will not be called again for this key" }, 409)
        }
      } else if (Date.now() - reservation.created_at >= 23 * 60 * 60 * 1000) {
        // Resend only retains idempotency keys for 24 hours.
        return reply({ error: "Send outcome is unresolved; contact the administrator before retrying" }, 409)
      }

      const result = await sendProviderEmail(providerConfig, {
        from: email.address,
        to,
        subject,
        html: content,
        idempotencyKey: reservation.id,
      })
      if (!result.ok || !result.providerId) {
        if (result.definitiveFailure) {
          await env.DB.prepare("UPDATE send_request SET status = 'failed' WHERE id = ? AND status = 'pending'")
            .bind(reservation.id).run()
          return reply({
            error: "Email provider rejected the request; correct the request or service configuration before a new attempt",
            retryWithNewKey: true,
          }, 502)
        }
        return reply({ error: "Email provider returned an unknown outcome; do not retry with a new key" }, 502)
      }
      await completeSend(env.DB, {
        id: reservation.id,
        userId,
        emailId: email.id,
        to,
        subject,
        content,
        providerId: result.providerId,
      })
    }
    return reply({
      success: true,
      remainingEmails: limit === 0 ? undefined : Math.max(0, limit - await countSends(env.DB, userId)),
    })
  } catch {
    return reply({ error: "Unable to confirm delivery; retry with the same Idempotency-Key" }, 503)
  }
}
