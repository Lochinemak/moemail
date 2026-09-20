import { loadConfig } from "./config.js";
import { ApiError, AuthError, ConfigError, PermissionError, QuotaError } from "./errors.js";

async function request(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  options: { signal?: AbortSignal; idempotencyKey?: string } = {},
): Promise<unknown> {
  const config = loadConfig();

  if (!config.apiUrl) {
    throw new ConfigError(
      "API URL not configured. Run `moemail config set api-url <url>` or set MOEMAIL_API_URL.",
    );
  }
  if (!config.apiKey) {
    throw new ConfigError(
      "API Key not configured. Run `moemail config set api-key <key>` or set MOEMAIL_API_KEY.",
    );
  }

  const url = `${config.apiUrl.replace(/\/$/, "")}${path}`;
  const headers: Record<string, string> = {
    "X-API-Key": config.apiKey,
  };
  if (body) {
    headers["Content-Type"] = "application/json";
  }
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000),
  });

  if (res.status === 204) {
    return null;
  }

  let data: any = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON body (e.g. empty error). Leave data as null.
  }

  if (res.ok) {
    return data;
  }

  const message = data?.error || `HTTP ${res.status}`;

  // Distinguish the error classes that a MoeMail Pro server returns so callers
  // can surface them accurately instead of lumping everything into "auth failed".
  switch (res.status) {
    case 401:
      throw new AuthError(message);
    case 403:
      throw new PermissionError(message);
    case 429:
      throw new QuotaError(message, data?.monthlyLimit, data?.monthlyUsed);
    default:
      throw new ApiError(res.status, message);
  }
}

export const api = {
  getConfig: () => request("GET", "/api/config"),

  createEmail: (body: { name?: string; expiryTime: number; domain: string }) =>
    request("POST", "/api/emails/generate", body as any),

  listEmails: (cursor?: string) =>
    request("GET", `/api/emails${cursor ? `?cursor=${cursor}` : ""}`),

  listMessages: (emailId: string, cursor?: string, signal?: AbortSignal) =>
    request("GET", `/api/emails/${encodeURIComponent(emailId)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, undefined, { signal }),

  getMessage: (emailId: string, messageId: string) =>
    request("GET", `/api/emails/${emailId}/${messageId}`),

  deleteEmail: (emailId: string) =>
    request("DELETE", `/api/emails/${emailId}`),

  deleteMessage: (emailId: string, messageId: string) =>
    request("DELETE", `/api/emails/${emailId}/${messageId}`),

  sendEmail: async (emailId: string, body: { to: string; subject: string; content: string }, idempotencyKey: string = crypto.randomUUID()) => {
    try {
      return await request("POST", `/api/emails/${encodeURIComponent(emailId)}/send`, body, { idempotencyKey });
    } catch (error) {
      if (error instanceof Error) error.message += ` (idempotency key: ${idempotencyKey}; reuse it for an unresolved attempt, use a new key only after a definitive rejection)`;
      throw error;
    }
  },
};
