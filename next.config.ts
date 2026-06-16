import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["react-map-gl"],
  experimental: {
    serverActions: {
      // Fotos de celular chegam a 10-15 MB; o padrão do Next.js é 1 MB
      bodySizeLimit: "52mb",
    },
  },
  // Headers de segurança HTTP
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-XSS-Protection", value: "1; mode=block" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // camera=(self) permite acesso à câmara no app do colaborador
          { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(self)" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              // 'unsafe-inline' necessário para Next.js hydration; sem Mapbox não precisamos de 'unsafe-eval'
              "script-src 'self' 'unsafe-inline' blob:",
              "style-src 'self' 'unsafe-inline'",
              // Inclui *.supabase.co para mostrar imagens guardadas no Supabase Storage
              "img-src 'self' data: blob: https://*.supabase.co https://*.cartocdn.com https://*.openstreetmap.org",
              "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.resend.com https://*.cartocdn.com https://nominatim.openstreetmap.org",
              "worker-src 'self' blob:",
              "font-src 'self' data:",
              "frame-ancestors 'none'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
