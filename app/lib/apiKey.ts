import { createDb } from "./db"
import { apiKeys } from "./schema"
import { eq, and, gt } from "drizzle-orm"
import { NextResponse } from "next/server"
import type { User } from "next-auth"
import { auth } from "./auth"
import { headers } from "next/headers"
import { hasPermission, PERMISSIONS, type Role } from "./permissions"

async function getUserByApiKey(key: string): Promise<User | null> {
  const db = createDb()
  const apiKey = await db.query.apiKeys.findFirst({
    where: and(
      eq(apiKeys.key, key),
      eq(apiKeys.enabled, true),
      gt(apiKeys.expiresAt, new Date())
    ),
    with: {
      user: { with: { userRoles: { with: { role: true } } } }
    }
  })

  if (!apiKey) return null

  const roles = apiKey.user.userRoles.map(record => record.role.name as Role)
  if (!hasPermission(roles, PERMISSIONS.MANAGE_API_KEY)) return null
  if (!hasPermission(roles, PERMISSIONS.MANAGE_EMAIL)) return null

  return apiKey.user
}

export async function handleApiKeyAuth(apiKey: string, pathname: string) {
  if (!(pathname === '/api/emails' || pathname.startsWith('/api/emails/') || pathname === '/api/config')) {
    return NextResponse.json(
      { error: "无权限查看" },
      { status: 403 }
    )
  }

  const user = await getUserByApiKey(apiKey)
  if (!user?.id) {
    return NextResponse.json(
      { error: "无效的 API Key" },
      { status: 401 }
    )
  }

  const requestHeaders = new Headers(await headers())
  requestHeaders.set("X-User-Id", user.id)
  
  const response = NextResponse.next({
    request: {
      headers: requestHeaders
    }
  })
  return response
}

export const getUserId = async () => {
  const headersList = await headers()
  const apiKey = headersList.get("X-API-Key")
  if (apiKey) return (await getUserByApiKey(apiKey))?.id

  const session = await auth()

  return session?.user.id
}
