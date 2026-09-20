/// <reference types="@cloudflare/workers-types" />


declare global {
  interface CloudflareEnv {
    DB: D1Database;
    SITE_CONFIG: KVNamespace;
    EMAIL_ASSETS: R2Bucket;
    MEDIA_SIGNING_SECRET?: string;
    MEDIA_MAX_BYTES?: string;
    MEDIA_TOTAL_MAX_BYTES?: string;
    MEDIA_URL_BASE?: string;
    MEDIA_ZONE_NAME?: string;
  }

  interface Window {
    turnstile?: {
      render: (element: HTMLElement | string, options: Record<string, unknown>) => string
      reset: (widgetId?: string) => void
      remove: (widgetId: string) => void
    }
  }

  type Env = CloudflareEnv
}

declare module "next-auth" {
  interface User {
    roles?: { name: string }[]
    username?: string | null
    providers?: string[]
  }

  interface Session {
    user: User
  }
}

export type { Env }
