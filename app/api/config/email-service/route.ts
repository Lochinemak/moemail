import { NextResponse } from "next/server"
import { getRequestContext } from "@cloudflare/next-on-pages"
import { checkPermission } from "@/lib/auth"
import { PERMISSIONS } from "@/lib/permissions"
import { EMAIL_CONFIG } from "@/config"
import { parseEmailProvider } from "@/lib/email-provider"
import { z } from "zod"

export const runtime = "edge"

const domainSchema = z.string().trim().toLowerCase().max(253).regex(
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
  "Invalid Mailgun domain"
)

const configSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(["resend", "mailgun"]),
  resend: z.object({ apiKey: z.string().trim().max(500).optional() }),
  mailgun: z.object({
    apiKey: z.string().trim().max(500).optional(),
    domain: z.string().trim().max(253),
  }),
  roleLimits: z.object({
    duke: z.number().int().min(-1),
    knight: z.number().int().min(-1),
  }),
})

export async function GET() {
  const canAccess = await checkPermission(PERMISSIONS.MANAGE_CONFIG)
  if (!canAccess) return NextResponse.json({ error: "权限不足" }, { status: 403 })

  try {
    const env = getRequestContext().env
    const [enabled, provider, resendApiKey, mailgunApiKey, mailgunDomain, roleLimits] = await Promise.all([
      env.SITE_CONFIG.get("EMAIL_SERVICE_ENABLED"),
      env.SITE_CONFIG.get("EMAIL_PROVIDER"),
      env.SITE_CONFIG.get("RESEND_API_KEY"),
      env.SITE_CONFIG.get("MAILGUN_API_KEY"),
      env.SITE_CONFIG.get("MAILGUN_DOMAIN"),
      env.SITE_CONFIG.get("EMAIL_ROLE_LIMITS"),
    ])
    const customLimits = roleLimits ? JSON.parse(roleLimits) : {}

    return NextResponse.json({
      enabled: enabled === "true",
      provider: parseEmailProvider(provider),
      resend: { apiKeyConfigured: Boolean(resendApiKey) },
      mailgun: {
        apiKeyConfigured: Boolean(mailgunApiKey),
        domain: mailgunDomain || "stu.glahu.edu.kg",
      },
      roleLimits: {
        duke: customLimits.duke ?? EMAIL_CONFIG.DEFAULT_DAILY_SEND_LIMITS.duke,
        knight: customLimits.knight ?? EMAIL_CONFIG.DEFAULT_DAILY_SEND_LIMITS.knight,
      },
    })
  } catch (error) {
    console.error("Failed to get email service config:", error)
    return NextResponse.json({ error: "获取发件服务配置失败" }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const canAccess = await checkPermission(PERMISSIONS.MANAGE_CONFIG)
  if (!canAccess) return NextResponse.json({ error: "权限不足" }, { status: 403 })

  try {
    const parsed = configSchema.safeParse(await request.json())
    if (!parsed.success) {
      return NextResponse.json({ error: "发件服务配置无效" }, { status: 400 })
    }
    const config = parsed.data
    const env = getRequestContext().env
    const [existingResendKey, existingMailgunKey] = await Promise.all([
      env.SITE_CONFIG.get("RESEND_API_KEY"),
      env.SITE_CONFIG.get("MAILGUN_API_KEY"),
    ])
    const resendKey = config.resend.apiKey || existingResendKey
    const mailgunKey = config.mailgun.apiKey || existingMailgunKey

    if (config.enabled && config.provider === "resend" && !resendKey) {
      return NextResponse.json({ error: "启用 Resend 时，API Key 为必填项" }, { status: 400 })
    }
    if (config.enabled && config.provider === "mailgun") {
      if (!mailgunKey) {
        return NextResponse.json({ error: "启用 Mailgun 时，API Key 为必填项" }, { status: 400 })
      }
      if (!domainSchema.safeParse(config.mailgun.domain).success) {
        return NextResponse.json({ error: "Mailgun 发信域名无效" }, { status: 400 })
      }
    }

    const writes = [
      env.SITE_CONFIG.put("EMAIL_SERVICE_ENABLED", config.enabled.toString()),
      env.SITE_CONFIG.put("EMAIL_PROVIDER", config.provider),
      env.SITE_CONFIG.put("MAILGUN_DOMAIN", config.mailgun.domain.toLowerCase()),
      env.SITE_CONFIG.put("EMAIL_ROLE_LIMITS", JSON.stringify(config.roleLimits)),
    ]
    if (config.resend.apiKey) writes.push(env.SITE_CONFIG.put("RESEND_API_KEY", config.resend.apiKey))
    if (config.mailgun.apiKey) writes.push(env.SITE_CONFIG.put("MAILGUN_API_KEY", config.mailgun.apiKey))
    await Promise.all(writes)

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("Failed to save email service config:", error)
    return NextResponse.json({ error: "保存发件服务配置失败" }, { status: 500 })
  }
}
