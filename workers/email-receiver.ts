import { Env } from '../types'
import { drizzle } from 'drizzle-orm/d1'
import { messages, emails, webhooks, messageAttachments } from '../app/lib/schema'
import { eq, sql, and, gt } from 'drizzle-orm'
import PostalMime from 'postal-mime'
import { WEBHOOK_CONFIG } from '../app/config/webhook'
import { callWebhook } from '../app/lib/webhook'
import { createMediaSignature, mediaUrl, normalizeContentId, sanitizeEmailHtml, detectImageType, rewriteCidImages } from '../app/lib/media'

const handleEmail = async (message: ForwardableEmailMessage, env: Env) => {
  const db = drizzle(env.DB, { schema: { messages, emails, webhooks, messageAttachments } })

  try {
    const targetEmail = await db.query.emails.findFirst({
      where: and(eq(sql`LOWER(${emails.address})`, message.to.toLowerCase()), gt(emails.expiresAt, new Date()))
    })

    if (!targetEmail) {
      message.setReject("Mailbox not found or expired")
      return
    }

    const parsedMessage = await PostalMime.parse(message.raw)
    const savedMessage = await db.insert(messages).values({
      emailId: targetEmail.id,
      fromAddress: message.from,
      subject: parsedMessage.subject || '(无主题)',
      content: parsedMessage.text || '',
      html: sanitizeEmailHtml(parsedMessage.html || ''),
      type: 'received',
    }).returning().get()

    const expiresAt = targetEmail.expiresAt
    const mediaBase = env.MEDIA_URL_BASE
    const cidUrls = new Map<string, string>()
    const attachments = (parsedMessage.attachments || []).map((attachment: any) => ({
      ...attachment,
      mediaType: attachment.mimeType || attachment.contentType || '',
    })).filter((attachment: any) =>
      attachment.mediaType.toLowerCase().startsWith('image/') &&
      attachment.contentId
    )
    let totalBytes = 0
    const seenContentIds = new Set<string>()
    const maxBytes = Number(env.MEDIA_MAX_BYTES || 10 * 1024 * 1024)
    const totalMaxBytes = Number(env.MEDIA_TOTAL_MAX_BYTES || 25 * 1024 * 1024)

    if (!env.MEDIA_SIGNING_SECRET || !mediaBase) {
      console.warn('Media signing secret or base URL missing; inline image storage skipped')
    }
    for (const attachment of env.MEDIA_SIGNING_SECRET && mediaBase ? attachments : []) {
      const content = attachment.content as ArrayBuffer | Uint8Array
      const bytes = content instanceof Uint8Array ? content.byteLength : content?.byteLength || 0
      if (!bytes || bytes > maxBytes || totalBytes + bytes > totalMaxBytes) continue
      const mediaType = detectImageType(content instanceof Uint8Array ? content : new Uint8Array(content))
      if (!mediaType) continue
      const normalizedContentId = normalizeContentId(attachment.contentId)
      if (!normalizedContentId || seenContentIds.has(normalizedContentId)) continue
      seenContentIds.add(normalizedContentId)
      totalBytes += bytes
      const attachmentId = crypto.randomUUID()
      const objectKey = 'messages/' + savedMessage.id + '/' + crypto.randomUUID()
      const exp = Math.floor(expiresAt.getTime() / 1000)
      await env.EMAIL_ASSETS.put(objectKey, content, {
        httpMetadata: {
          contentType: mediaType,
          cacheControl: 'private, no-store',
        },
        customMetadata: attachment.filename ? { filename: attachment.filename } : undefined,
      })
      const signature = await createMediaSignature(env.MEDIA_SIGNING_SECRET || '', savedMessage.id, attachmentId, exp)
      try {
        await db.insert(messageAttachments).values({
          id: attachmentId,
          messageId: savedMessage.id,
          contentId: normalizedContentId,
          objectKey,
          contentType: mediaType,
          size: bytes,
          mediaToken: signature,
          expiresAt,
        })
      } catch (error) {
        // A concurrent mailbox deletion or DB failure must not orphan the upload.
        await env.DB.prepare("INSERT OR IGNORE INTO asset_deletion_queue(object_key) VALUES (?)").bind(objectKey).run()
        throw error
      }
      const url = mediaUrl(mediaBase!, savedMessage.id, attachmentId, exp, signature)
      cidUrls.set(normalizedContentId, url)
    }
    const rewrittenHtml = await rewriteCidImages(savedMessage.html || '', cidUrls)
    if (rewrittenHtml !== savedMessage.html) {
      await db.update(messages).set({ html: rewrittenHtml }).where(eq(messages.id, savedMessage.id))
      savedMessage.html = rewrittenHtml
    }

    const webhook = await db.query.webhooks.findFirst({
      where: eq(webhooks.userId, targetEmail!.userId!)
    })

    if (webhook?.enabled) {
      try {
        await callWebhook(webhook.url, {
          event: WEBHOOK_CONFIG.EVENTS.NEW_MESSAGE,
          data: {
            emailId: targetEmail.id,
            messageId: savedMessage.id,
            fromAddress: savedMessage.fromAddress || '',
            subject: savedMessage.subject,
            content: savedMessage.content,
            html: savedMessage.html || '',
            receivedAt: savedMessage.receivedAt.toISOString(),
            toAddress: targetEmail.address,
          },
        })
      } catch {
        console.error('Webhook delivery failed', { messageId: savedMessage.id })
      }
    }

    console.log("Email processed", { messageId: savedMessage.id })
  } catch {
    console.error('Email processing failed')
  }
}

const worker = {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await handleEmail(message, env)
  }
}

export default worker
