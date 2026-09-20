export type EmailProvider = "resend" | "mailgun"

export interface EmailProviderConfig {
  provider: EmailProvider
  apiKey: string | null
  domain?: string
}

interface SendEmailInput {
  from: string
  to: string
  subject: string
  html: string
  idempotencyKey: string
}

export interface ProviderResponse {
  ok: boolean
  providerId?: string
  definitiveFailure?: boolean
}

export function parseEmailProvider(value: string | null): EmailProvider {
  return value === "mailgun" ? "mailgun" : "resend"
}

export async function getEmailProviderConfig(
  config: KVNamespace,
  provider?: EmailProvider
): Promise<EmailProviderConfig> {
  const selectedProvider = provider ?? parseEmailProvider(await config.get("EMAIL_PROVIDER"))

  if (selectedProvider === "mailgun") {
    const [apiKey, domain] = await Promise.all([
      config.get("MAILGUN_API_KEY"),
      config.get("MAILGUN_DOMAIN"),
    ])
    return {
      provider: selectedProvider,
      apiKey,
      domain: domain?.trim().toLowerCase(),
    }
  }

  return {
    provider: selectedProvider,
    apiKey: await config.get("RESEND_API_KEY"),
  }
}

export function getEmailDomain(address: string) {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase()
}

export async function sendProviderEmail(
  config: EmailProviderConfig,
  input: SendEmailInput
): Promise<ProviderResponse> {
  if (!config.apiKey) return { ok: false, definitiveFailure: true }

  if (config.provider === "mailgun") {
    if (!config.domain) return { ok: false, definitiveFailure: true }

    const body = new FormData()
    body.set("from", input.from)
    body.set("to", input.to)
    body.set("subject", input.subject)
    body.set("html", input.html)

    const response = await fetch(
      `https://api.mailgun.net/v3/${encodeURIComponent(config.domain)}/messages`,
      {
        method: "POST",
        headers: { Authorization: `Basic ${btoa(`api:${config.apiKey}`)}` },
        body,
        signal: AbortSignal.timeout(15_000),
      }
    )
    if (!response.ok) {
      return {
        ok: false,
        definitiveFailure: response.status >= 400 && response.status < 500 && response.status !== 429,
      }
    }
    const result = await response.json() as { id?: string }
    return result.id
      ? { ok: true, providerId: result.id }
      : { ok: false }
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      "Idempotency-Key": `moemail-${input.idempotencyKey}`,
    },
    body: JSON.stringify({
      from: input.from,
      to: [input.to],
      subject: input.subject,
      html: input.html,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    return {
      ok: false,
      definitiveFailure: [400, 401, 403, 404, 422].includes(response.status),
    }
  }
  const result = await response.json() as { id?: string }
  return result.id
    ? { ok: true, providerId: result.id }
    : { ok: false }
}
