import pg from "pg";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Conexão direta via IPv6
const client = new pg.Client({
  host: "db.ceqzxgizhgmvcniapyla.supabase.co",
  port: 5432,
  database: "postgres",
  user: "postgres",
  password: "@vitortmf36978",
  ssl: { rejectUnauthorized: false },
});

const MIGRATIONS_DIR = join(__dirname, "../supabase/migrations");

async function run() {
  console.log("🔌 A conectar ao Supabase Postgres...");
  await client.connect();
  console.log("✅ Conectado!\n");

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const path = join(MIGRATIONS_DIR, file);
    const sql = readFileSync(path, "utf8");
    console.log(`📦 Aplicando ${file}...`);
    try {
      await client.query(sql);
      console.log(`   ✅ OK\n`);
    } catch (err) {
      // Ignora erros de "já existe" (idempotente)
      if (
        err.message.includes("already exists") ||
        err.message.includes("duplicate") ||
        err.message.includes("já existe")
      ) {
        console.log(`   ⚠️  Já existe (ignorado)\n`);
      } else {
        console.error(`   ❌ ERRO: ${err.message}\n`);
        await client.end();
        process.exit(1);
      }
    }
  }

  console.log("🌱 Aplicando seed.sql...");
  try {
    const seed = readFileSync(join(__dirname, "../supabase/seed.sql"), "utf8");
    await client.query(seed);
    console.log("✅ Seed aplicado!\n");
  } catch (err) {
    if (err.message.includes("already exists") || err.message.includes("duplicate") || err.message.includes("violates unique")) {
      console.log("⚠️  Seed já aplicado anteriormente (ignorado)\n");
    } else {
      console.error(`❌ Erro no seed: ${err.message}\n`);
    }
  }

  await client.end();
  console.log("🎉 Todas as migrations aplicadas com sucesso!");
}

run().catch((err) => {
  console.error("Erro fatal:", err.message);
  process.exit(1);
});
