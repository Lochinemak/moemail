import withPWA from 'next-pwa'
import createNextIntlPlugin from 'next-intl/plugin'
import { setupDevPlatform } from '@cloudflare/next-on-pages/next-dev';

async function setup() {
  if (process.env.NODE_ENV === 'development') {
    await setupDevPlatform()
  }
}

setup()

const withNextIntl = createNextIntlPlugin('./app/i18n/request.ts')

const nextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'avatars.githubusercontent.com',
      },
      {
        protocol: 'https',
        hostname: '*.googleusercontent.com',
      }
    ],
  },
};

const withPWAConfigured = withPWA({
  dest: 'public',
  register: true,
  skipWaiting: true,
  importScripts: ["/privacy-worker.js"],
  cacheStartUrl: false,
  dynamicStartUrl: false,
  cacheOnFrontEndNav: false,
  // Never cache mail, config, shared content or authenticated navigation.
  runtimeCaching: [{
    urlPattern: ({ url }: { url: URL }) => url.origin === self.location.origin && url.pathname.startsWith("/_next/static/"),
    handler: "CacheFirst",
    options: { cacheName: "moemail-static-v2" },
  }, {
    urlPattern: /.*/,
    handler: "NetworkOnly",
  }],
  publicExcludes: ["!noprecache/**/*", "!**/*.html"],
  disable: process.env.NODE_ENV === 'development',
}) as any

const configWithPWA = withPWAConfigured(nextConfig as any) as any

export default withNextIntl(configWithPWA)
