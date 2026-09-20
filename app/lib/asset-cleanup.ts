interface AssetCleanupEnv {
  DB: D1Database
  EMAIL_ASSETS: R2Bucket
}

export async function drainAssetDeletionQueue(env: AssetCleanupEnv, batches = 1) {
  for (let i = 0; i < batches; i++) {
    const { results } = await env.DB.prepare(
      "SELECT object_key FROM asset_deletion_queue ORDER BY object_key LIMIT 100"
    ).all<{ object_key: string }>()
    if (!results.length) return

    // Keep queue entries until R2 confirms deletion; retrying deletion is safe.
    await env.EMAIL_ASSETS.delete(results.map(row => row.object_key))
    await env.DB.batch(results.map(row => env.DB.prepare(
      "DELETE FROM asset_deletion_queue WHERE object_key = ?"
    ).bind(row.object_key)))
  }
}

export async function tryDrainAssetDeletionQueue(env: AssetCleanupEnv) {
  try {
    await drainAssetDeletionQueue(env)
  } catch {
    console.error("Asset deletion deferred to the cleanup worker")
  }
}
