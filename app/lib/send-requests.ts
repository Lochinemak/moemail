export interface SendRequest {
  id: string
  payload_hash: string
  status: "pending" | "sent" | "failed"
  provider_id: string | null
  created_at: number
}

export function startOfUtcDay(now = Date.now()) {
  return Math.floor(now / 86_400_000) * 86_400_000
}

export async function reserveSend(db: D1Database, userId: string, key: string, hash: string, limit: number) {
  const now = Date.now()
  // The quota check and reservation are one SQLite write. The unique key also
  // makes two concurrent attempts at the same logical send share a reservation.
  await db.prepare(`
    INSERT INTO send_request (id, user_id, request_key, payload_hash, status, created_at)
    SELECT ?, ?, ?, ?, 'pending', ?
    WHERE ? = 0 OR (SELECT COUNT(*) FROM send_request
      WHERE user_id = ? AND created_at >= ? AND status != 'failed') < ?
    ON CONFLICT(user_id, request_key) DO NOTHING
  `).bind(crypto.randomUUID(), userId, key, hash, now, limit, userId, startOfUtcDay(now), limit).run()
  return db.prepare("SELECT * FROM send_request WHERE user_id = ? AND request_key = ?")
    .bind(userId, key).first<SendRequest>()
}

export async function countSends(db: D1Database, userId: string) {
  const result = await db.prepare(
    "SELECT COUNT(*) AS used FROM send_request WHERE user_id = ? AND created_at >= ? AND status != 'failed'"
  ).bind(userId, startOfUtcDay()).first<{ used: number }>()
  return result?.used ?? 0
}

export async function completeSend(db: D1Database, send: {
  id: string; userId: string; emailId: string; to: string; subject: string; content: string; providerId: string
}) {
  const now = Date.now()
  await db.batch([
    // Persist mail only on the first completion. A late concurrent retry must
    // not resurrect a message or mailbox that the user already deleted.
    db.prepare(`INSERT INTO message (id, emailId, from_address, to_address, subject, content, html, type, received_at, sent_at)
      SELECT ?, id, address, ?, ?, '', ?, 'sent', ?, ? FROM email WHERE id = ? AND userId = ?
      AND EXISTS (SELECT 1 FROM send_request WHERE id = ? AND status = 'pending')
      ON CONFLICT(id) DO NOTHING`).bind(send.id, send.to, send.subject, send.content, now, now, send.emailId, send.userId, send.id),
    db.prepare("UPDATE send_request SET status = 'sent', provider_id = ? WHERE id = ?")
      .bind(send.providerId, send.id),
  ])
}
