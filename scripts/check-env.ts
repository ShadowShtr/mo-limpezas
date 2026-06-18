/**
 * Valida variáveis de ambiente obrigatórias antes do build.
 * Executar: npx tsx scripts/check-env.ts
 * Integrado no package.json: "prebuild": "npx tsx scripts/check-env.ts"
 */

const REQUIRED: Record<string, { desc: string; example: string }> = {
  NEXT_PUBLIC_SUPABASE_URL: {
    desc: "URL do projeto Supabase",
    example: "https://xxxx.supabase.co",
  },
  NEXT_PUBLIC_SUPABASE_ANON_KEY: {
    desc: "Chave anon pública do Supabase",
    example: "eyJ...",
  },
  SUPABASE_SERVICE_ROLE_KEY: {
    desc: "Service role key (server-side only)",
    example: "eyJ...",
  },
  NEXT_PUBLIC_MAPBOX_TOKEN: {
    desc: "Token Mapbox GL JS",
    example: "pk.eyJ...",
  },
  RESEND_API_KEY: {
    desc: "API key do Resend para emails transacionais",
    example: "re_...",
  },
  RESEND_FROM_EMAIL: {
    desc: "Remetente de email (ex: Mo Limpezas <noreply@molimpezas.pt>)",
    example: "Mo Limpezas <onboarding@resend.dev>",
  },
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: {
    desc: "Chave pública VAPID para Web Push",
    example: "BJ...",
  },
  VAPID_PRIVATE_KEY: {
    desc: "Chave privada VAPID (server-side only)",
    example: "...",
  },
  VAPID_SUBJECT: {
    desc: "Email de contacto VAPID (mailto:...)",
    example: "mailto:admin@molimpezas.pt",
  },
  CRON_SECRET: {
    desc: "Secret para proteger rotas /api/cron/*",
    example: "um-segredo-longo-e-aleatório",
  },
};

const missing: string[] = [];

for (const [key, meta] of Object.entries(REQUIRED)) {
  const val = process.env[key];
  if (!val || val.trim() === "") {
    console.error(`❌  ${key} — ${meta.desc}`);
    console.error(`    Exemplo: ${meta.example}`);
    missing.push(key);
  }
}

if (missing.length > 0) {
  console.error(`\n🚫  Build cancelado: ${missing.length} variável(s) de ambiente em falta.\n`);
  console.error("    Adiciona as vars em falta no Vercel (Settings → Environment Variables)");
  console.error("    ou no ficheiro .env.local para desenvolvimento local.\n");
  process.exit(1);
}

console.log("✅  Todas as variáveis de ambiente obrigatórias estão presentes.\n");
