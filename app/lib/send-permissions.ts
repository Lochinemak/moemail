import { createDb } from "@/lib/db"
import { userRoles, roles } from "@/lib/schema"
import { eq } from "drizzle-orm"
import { getRequestContext } from "@cloudflare/next-on-pages"
import { EMAIL_CONFIG } from "@/config"
import { countSends } from "./send-requests"

export interface SendPermissionResult {
  canSend: boolean
  canViewSent?: boolean
  error?: string
  remainingEmails?: number
}

export async function checkSendPermission(
  userId: string,
  skipDailyLimitCheck = false
): Promise<SendPermissionResult> {
  try {
    const env = getRequestContext().env
    const enabled = await env.SITE_CONFIG.get("EMAIL_SERVICE_ENABLED")

    if (enabled !== "true") {
      return {
        canSend: false,
        error: "邮件发送服务未启用"
      }
    }

    const userDailyLimit = await getUserDailyLimit(userId)
    
    if (userDailyLimit === -1) {
      return {
        canSend: false,
        error: "您的角色没有发件权限"
      }
    }

    if (skipDailyLimitCheck || userDailyLimit === 0) {
      return {
        canSend: true,
        canViewSent: true
      }
    }
    
    const sentToday = await countSends(env.DB, userId)
    const remainingEmails = Math.max(0, userDailyLimit - sentToday)
    
    if (sentToday >= userDailyLimit) {
      return {
        canSend: false,
        canViewSent: true,
        error: `您今天已达到发件限制 (${userDailyLimit} 封)，请明天再试`,
        remainingEmails: 0
      }
    }

    return {
      canSend: true,
      canViewSent: true,
      remainingEmails
    }
  } catch (error) {
    console.error('Failed to check send permission:', error)
    return {
      canSend: false,
      error: "权限检查失败"
    }
  }
}

export async function getUserDailyLimit(userId: string): Promise<number> {
  try {
    const db = createDb()
    
    const userRoleData = await db
      .select({ roleName: roles.name })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(eq(userRoles.userId, userId))

    const userRoleNames = userRoleData.map(r => r.roleName)

    const env = getRequestContext().env
    const roleLimitsStr = await env.SITE_CONFIG.get("EMAIL_ROLE_LIMITS")
    
    const customLimits = roleLimitsStr ? JSON.parse(roleLimitsStr) : {}
    
    const finalLimits = {
      emperor: EMAIL_CONFIG.DEFAULT_DAILY_SEND_LIMITS.emperor,
      duke: customLimits.duke !== undefined ? customLimits.duke : EMAIL_CONFIG.DEFAULT_DAILY_SEND_LIMITS.duke,
      knight: customLimits.knight !== undefined ? customLimits.knight : EMAIL_CONFIG.DEFAULT_DAILY_SEND_LIMITS.knight,
      civilian: EMAIL_CONFIG.DEFAULT_DAILY_SEND_LIMITS.civilian,
    }

    const role = (["emperor", "duke", "knight", "civilian"] as const).find(name => userRoleNames.includes(name))
    const limit = role ? finalLimits[role] : -1
    return Number.isSafeInteger(limit) && limit >= -1 ? limit : -1
  } catch (error) {
    console.error('Failed to get user daily limit:', error)
    return -1
  }
}

export async function checkBasicSendPermission(userId: string): Promise<SendPermissionResult> {
  return checkSendPermission(userId, true)
}
