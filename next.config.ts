import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Output as standalone for server deployment
  output: 'standalone',

  // Security headers. The CSP is a pragmatic baseline, not a strict
  // lockdown: Next.js needs 'unsafe-inline' for its scripts and the
  // app uses inline style attributes; the on-device OCR (tesseract)
  // loads its worker/core from jsdelivr and compiles WASM, and the
  // shape model (coco-ssd) is fetched from Google storage — all of
  // those are allow-listed explicitly below.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
              "worker-src 'self' blob: https://cdn.jsdelivr.net",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https:",
              'connect-src \'self\' https://*.us-west.insforge.app https://storage.googleapis.com',
              "font-src 'self'",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
        ],
      },
    ];
  },

  // Ensure images work with external URLs
  images: {
    unoptimized: true,
  },
  
  // Environment variables available at build time
  env: {
    NEXT_PUBLIC_INSFORGE_URL: process.env.NEXT_PUBLIC_INSFORGE_URL,
    NEXT_PUBLIC_INSFORGE_ANON_KEY: process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY,
  },
};

export default nextConfig;
