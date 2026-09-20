import { Env } from '../types'
import { drizzle } from 'drizzle-orm/d1'
import { messages, emails, webhooks, messageAttachments } from '../app/lib/schema'
import { eq, sql } from 'drizzle-orm'
import PostalMime from 'postal-mime'
import { WEBHOOK_CONFIG } from '../app/config/webhook'
import { EmailMessage } from '../app/lib/webhook'
import { createMediaSignature, mediaUrl, normalizeContentId, sanitizeEmailHtml } from '../app/lib/media'

const handleEmail = async (message: ForwardableEmailMessage, env: Env) => {
  const db = drizzle(env.DB, { schema: { messages, emails, webhooks, messageAttachments } })

  const parsedMessage = await PostalMime.parse(message.raw)

  console.log("parsedMessage:", parsedMessage)

  try {
    const targetEmail = await db.query.emails.findFirst({
      where: eq(sql`LOWER(${emails.address})`, message.to.toLowerCase())
    })

    if (!targetEmail) {
      console.error(`Email not found: ${message.to}`)
      return
    }

    const savedMessage = await db.insert(messages).values({
      emailId: targetEmail.id,
      fromAddress: message.from,
      subject: parsedMessage.subject || '(无主题)',
      content: parsedMessage.text || '',
      html: sanitizeEmailHtml(parsedMessage.html || ''),
      type: 'received',
    }).returning().get()

    const expiresAt = targetEmail.expiresAt
    const mediaBase = env.MEDIA_URL_BASE || 'https://moemail.app'
    const attachments = (parsedMessage.attachments || []).filter((attachment: any) =>
      typeof attachment.contentType === 'string' &&
      attachment.contentType.toLowerCase().startsWith('image/') &&
      attachment.contentId
    )
    let totalBytes = 0
    let rewrittenHtml = savedMessage.html || ''
    const seenContentIds = new Set<string>()
    const maxBytes = Number(env.MEDIA_MAX_BYTES || 10 * 1024 * 1024)
    const totalMaxBytes = Number(env.MEDIA_TOTAL_MAX_BYTES || 25 * 1024 * 1024)

    if (!env.MEDIA_SIGNING_SECRET) {
      console.warn('MEDIA_SIGNING_SECRET is not configured; CID images will remain unresolved')
    }
    for (const attachment of env.MEDIA_SIGNING_SECRET ? attachments as any[] : []) {
      const content = attachment.content as ArrayBuffer | Uint8Array
      const bytes = content instanceof Uint8Array ? content.byteLength : content?.byteLength || 0
      if (!bytes || bytes > maxBytes || totalBytes + bytes > totalMaxBytes) continue
      const normalizedContentId = normalizeContentId(attachment.contentId)
      if (!normalizedContentId || seenContentIds.has(normalizedContentId)) continue
      seenContentIds.add(normalizedContentId)
      totalBytes += bytes
      const attachmentId = crypto.randomUUID()
      const objectKey = 'messages/' + savedMessage.id + '/' + crypto.randomUUID()
      const exp = Math.floor(expiresAt.getTime() / 1000)
      await env.EMAIL_ASSETS.put(objectKey, content, {
        httpMetadata: {
          contentType: attachment.contentType,
          cacheControl: 'public, max-age=86400, immutable',
        },
        customMetadata: attachment.filename ? { filename: attachment.filename } : undefined,
      })
      await db.insert(messageAttachments).values({
        id: attachmentId,
        messageId: savedMessage.id,
        contentId: normalizedContentId,
        objectKey,
        contentType: attachment.contentType,
        size: bytes,
        expiresAt,
      })
      const signature = await createMediaSignature(env.MEDIA_SIGNING_SECRET || '', savedMessage.id, attachmentId, exp)
      const url = mediaUrl(mediaBase, savedMessage.id, attachmentId, exp, signature)
      const cid = normalizedContentId
      rewrittenHtml = rewrittenHtml.replace(new RegExp('cid:[ ]*<?' + cid.replace(/[.*+?^()|[\\]\\\\]/g, '\\\\$&') + '>?', 'gi'), url)
    }
    if (rewrittenHtml !== savedMessage.html) {
      await db.update(messages).set({ html: rewrittenHtml }).where(eq(messages.id, savedMessage.id))
      savedMessage.html = rewrittenHtml
    }

    const webhook = await db.query.webhooks.findFirst({
      where: eq(webhooks.userId, targetEmail!.userId!)
    })

    if (webhook?.enabled) {
      try {
        await fetch(webhook.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Event': WEBHOOK_CONFIG.EVENTS.NEW_MESSAGE
          },
          body: JSON.stringify({
            emailId: targetEmail.id,
            messageId: savedMessage.id,
            fromAddress: savedMessage.fromAddress,
            subject: savedMessage.subject,
            content: savedMessage.content,
            html: savedMessage.html,
            receivedAt: savedMessage.receivedAt.toISOString(),
            toAddress: targetEmail.address
          } as EmailMessage)
        })
      } catch (error) {
        console.error('Failed to send webhook:', error)
      }
    }

    console.log(`Email processed: ${parsedMessage.subject}`)
  } catch (error) {
    console.error('Failed to process email:', error)
  }
}

const worker = {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await handleEmail(message, env)
  }
}

export default worker
