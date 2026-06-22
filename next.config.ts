import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["react-map-gl"],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.supabase.co",
        pathname: "/storage/v1/object/**",
      },
    ],
  },
  experimental: {
    serverActions: {
      // Uploads de fotos e documentos vão via signed URL (fetch PUT direto ao Supabase),
      // não por server actions — o limite é para metadados e payloads normais.
      bodySizeLimit: "4mb",
    },
  },
  // Headers de segurança HTTP
  async headers() {
    return [
      {
        // sw.js nunca pode ser cacheado — o browser precisa sempre da versão mais recente
        // para detectar actualizações do service worker
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-XSS-Protection", value: "1; mode=block" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // camera=(self) permite acesso à câmara no app do colaborador
          {
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(), geolocation=(self), payment=(), usb=(), serial=(), bluetooth=(), midi=(), interest-cohort=()",
          },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains; preload" },
          { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' blob:",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https://*.supabase.co https://*.cartocdn.com https://*.openstreetmap.org https://*.mapbox.com",
              "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.resend.com https://*.cartocdn.com https://nominatim.openstreetmap.org https://api.mapbox.com https://events.mapbox.com https://*.tiles.mapbox.com",
              "worker-src 'self' blob:",
              "font-src 'self' data:",
              "media-src 'self' blob:",
              "frame-src 'none'",
              "frame-ancestors 'none'",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
