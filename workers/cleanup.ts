interface Env {
  DB: D1Database
  EMAIL_ASSETS: R2Bucket
}

const CLEANUP_CONFIG = {
  // Whether to delete expired emails
  DELETE_EXPIRED_EMAILS: true,
  
  // Batch processing size
  BATCH_SIZE: 100,
} as const 

const main = {
  async scheduled(_: ScheduledEvent, env: Env) {
    const now = Date.now()

    try {
      if (!CLEANUP_CONFIG.DELETE_EXPIRED_EMAILS) {
        console.log('Expired email deletion is disabled')
        return
      }

      const expired = await env.DB.prepare(
        "SELECT ma.object_key AS objectKey FROM message_attachment ma JOIN message m ON m.id = ma.message_id JOIN email e ON e.id = m.emailId WHERE e.expires_at < ? LIMIT ?"
      ).bind(now, CLEANUP_CONFIG.BATCH_SIZE).all<{ objectKey: string }>()
      await Promise.all((expired.results || []).map((row) => env.EMAIL_ASSETS.delete(row.objectKey)))
      await env.DB.prepare(
        "DELETE FROM message_attachment WHERE message_id IN (SELECT m.id FROM message m JOIN email e ON e.id = m.emailId WHERE e.expires_at < ? LIMIT ?)"
      ).bind(now, CLEANUP_CONFIG.BATCH_SIZE).run()

      const result = await env.DB
        .prepare(`
          DELETE FROM email 
          WHERE expires_at < ?
          LIMIT ?
        `)
        .bind(now, CLEANUP_CONFIG.BATCH_SIZE)
        .run()

      if (result.success) {
        console.log(`Deleted ${result?.meta?.changes ?? 0} expired emails and their associated messages`)
      } else {
        console.error('Failed to delete expired emails')
      }
    } catch (error) {
      console.error('Failed to cleanup:', error)
      throw error
    }
  }
}

export default main
