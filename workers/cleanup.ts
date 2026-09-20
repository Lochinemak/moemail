import { drainAssetDeletionQueue } from "../app/lib/asset-cleanup"

interface Env {
  DB: D1Database
  EMAIL_ASSETS: R2Bucket
}

export default {
  async scheduled(_: ScheduledEvent, env: Env) {
    // Cascades enqueue every attachment in the same database transaction.
    const result = await env.DB.prepare(
      "DELETE FROM email WHERE id IN (SELECT id FROM email WHERE expires_at <= ? ORDER BY expires_at, id LIMIT 100)"
    ).bind(Date.now()).run()
    await drainAssetDeletionQueue(env, 10)
    console.log(`Deleted ${result.meta.changes} expired mailboxes`)
  },
}
