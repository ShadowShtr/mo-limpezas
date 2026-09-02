// ============================================================================
// CONTENTOR POSTGRESQL DESCARTÁVEL PARA TESTES — arranque e prontidão
// ============================================================================
//
// Porque é que isto existe, e porque é que `pg_isready` sozinho não serve.
//
// O entrypoint da imagem oficial do PostgreSQL, quando o volume de dados está
// vazio, faz duas coisas por ordem:
//
//   1. corre o `initdb` e levanta um servidor TEMPORÁRIO, ligado apenas ao
//      socket Unix de dentro do contentor, para aplicar scripts de arranque;
//   2. desliga esse servidor e arranca o definitivo, esse sim à escuta em TCP.
//
// `docker exec <c> pg_isready` fala pelo socket interno. Durante o passo 1 já
// responde 0 — e um teste que trate isso como «pronto» abre a ligação TCP
// exactamente na janela em que o servidor temporário vai ser desligado. O erro
// que sai daí é `Connection terminated unexpectedly`, e é intermitente: numa
// máquina onde a imagem ainda tem de ser puxada, o download atrasa o suficiente
// para a corrida se perder e o teste passar. Foi assim que este defeito
// sobreviveu a um CI verde.
//
// A prontidão real só se pode medir pela mesma interface que a suite vai usar:
// 127.0.0.1 na porta publicada, ligação PostgreSQL a sério, `SELECT 1` a
// devolver. É o que `startPostgresContainer` faz, e só depois disso devolve.
// ============================================================================

import { spawnSync } from "node:child_process";
import pg from "pg";

/** Imagem única para todas as suites: uma versão, um comportamento. */
export const POSTGRES_IMAGE = "postgres:17-alpine";

export interface PostgresContainerOptions {
  /** Nome do contentor. Inclua o PID para que suites em paralelo não colidam. */
  name: string;
  /** Base criada pelo entrypoint (`POSTGRES_DB`). */
  database: string;
  /** Limites do contentor. Os valores por omissão servem uma suite pequena. */
  memory?: string;
  cpus?: string;
  shmSize?: string;
  /** Parâmetros passados ao postgres depois da imagem (`-c chave=valor`). */
  serverFlags?: string[];
  /** Tecto total do arranque, do `docker run` ao `SELECT 1`. */
  readyTimeoutMs?: number;
  /** Intervalo entre tentativas de prontidão. */
  pollIntervalMs?: number;
}

export interface PostgresContainer {
  /** Nome do contentor, para `docker exec`/`docker logs` dentro da suite. */
  name: string;
  /** Porta TCP publicada no host. Validada: inteiro em 1–65535. */
  port: number;
  /** Parâmetros de ligação já apontados ao contentor. */
  connection: { host: string; port: number; user: string; database: string };
  /** Remove o contentor. Idempotente e nunca lança. */
  stop: () => void;
}

const docker = (args: string[]) => spawnSync("docker", args, { encoding: "utf8" });

/**
 * Uma falha de ligação que ainda pode desaparecer sozinha.
 *
 * Só estas justificam nova tentativa: o servidor pode não estar à escuta
 * (`ECONNREFUSED`), a ligação pode ser cortada quando o servidor temporário do
 * `initdb` desliga (`ECONNRESET`, `Connection terminated unexpectedly`), ou o
 * PostgreSQL pode ainda estar a arrancar (`57P03`). Um erro de autenticação ou
 * uma base inexistente não são transitórios: repetir só gastaria o timeout a
 * esconder a causa real.
 */
function isTransientConnectionError(error: unknown): boolean {
  const e = error as { code?: string; message?: string };
  const code = e?.code ?? "";
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE" || code === "57P03") return true;
  const message = (e?.message ?? "").toLowerCase();
  return (
    message.includes("connection terminated") ||
    message.includes("connection refused") ||
    message.includes("socket hang up") ||
    message.includes("server closed the connection") ||
    message.includes("starting up") ||
    message.includes("shutting down") ||
    message.includes("timeout expired")
  );
}

/** Lê a porta publicada e recusa qualquer coisa que não seja uma porta válida. */
function readPublishedPort(name: string): number {
  const mapping = docker(["port", name, "5432/tcp"]).stdout.trim();
  if (!mapping) throw new Error(`Contentor ${name}: docker port não devolveu mapeamento para 5432/tcp.`);
  // Um mapeamento pode trazer várias linhas (IPv4 e IPv6). A primeira basta.
  const first = mapping.split(/\r?\n/)[0].trim();
  const port = Number(first.slice(first.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Contentor ${name}: porta publicada inválida em "${mapping}".`);
  }
  return port;
}

/**
 * Prontidão medida pela interface que a suite vai usar de facto.
 *
 * `pg_isready` interno não entra aqui nem como atalho: a única prova aceite é
 * uma ligação TCP externa que execute `SELECT 1` e devolva 1.
 */
async function waitForExternalReadiness(args: {
  name: string;
  port: number;
  database: string;
  readyTimeoutMs: number;
  pollIntervalMs: number;
}): Promise<void> {
  const deadline = Date.now() + args.readyTimeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    // Se o contentor morreu (OOM, flag inválida), esperar pelo timeout só
    // atrasaria o diagnóstico. Falhar já, com os logs, é mais útil.
    if (docker(["inspect", "-f", "{{.State.Running}}", args.name]).stdout.trim() !== "true") {
      const logs = docker(["logs", "--tail", "40", args.name]).stdout || "";
      throw new Error(`Contentor ${args.name} parou antes de ficar pronto.\n${logs}`);
    }

    const client = new pg.Client({
      host: "127.0.0.1",
      port: args.port,
      user: "postgres",
      database: args.database,
      connectionTimeoutMillis: 3_000,
    });
    // `pg` emite 'error' no cliente quando a ligação cai fora de uma query; sem
    // ouvinte, o Node derrubaria o processo de teste em vez de nos deixar tentar
    // outra vez.
    client.on("error", () => { /* transitório: tratado pelo ciclo */ });
    try {
      await client.connect();
      const result = await client.query("SELECT 1 AS ok");
      if (result.rows[0]?.ok !== 1) throw new Error("SELECT 1 não devolveu 1.");
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      try { await client.end(); } catch { /* pode nunca ter aberto */ }
      if (!isTransientConnectionError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, args.pollIntervalMs));
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `PostgreSQL do contentor ${args.name} não ficou pronto em ${args.readyTimeoutMs}ms. Último erro: ${detail}`,
  );
}

/**
 * Arranca um PostgreSQL descartável e só devolve quando ele responde a sério.
 *
 * Garante limpeza: se a prontidão falhar, o contentor é removido antes de a
 * excepção subir, para não deixar lixo atrás em CI nem na máquina de ninguém.
 */
export async function startPostgresContainer(
  options: PostgresContainerOptions,
): Promise<PostgresContainer> {
  const {
    name,
    database,
    memory = "384m",
    cpus = "0.5",
    shmSize = "32m",
    serverFlags = ["shared_buffers=8MB", "max_connections=10", "work_mem=1MB", "maintenance_work_mem=8MB"],
    readyTimeoutMs = 120_000,
    pollIntervalMs = 250,
  } = options;

  // Um contentor com o mesmo nome de uma execução interrompida impediria o
  // arranque. Remover antes é mais fiável do que confiar no `--rm`.
  docker(["rm", "-f", name]);

  const flags = serverFlags.flatMap((flag) => ["-c", flag]);
  const started = docker([
    "run", "--rm", "-d", "--name", name,
    `--memory=${memory}`, `--memory-swap=${memory}`, `--cpus=${cpus}`, `--shm-size=${shmSize}`,
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", `POSTGRES_DB=${database}`,
    "-p", "127.0.0.1::5432", POSTGRES_IMAGE,
    ...flags,
  ]);
  if (started.status !== 0) throw new Error(started.stderr || started.stdout);

  const stop = () => {
    try { docker(["rm", "-f", name]); } catch { /* já não existe */ }
  };

  try {
    const port = readPublishedPort(name);
    await waitForExternalReadiness({ name, port, database, readyTimeoutMs, pollIntervalMs });
    return { name, port, connection: { host: "127.0.0.1", port, user: "postgres", database }, stop };
  } catch (error) {
    stop();
    throw error;
  }
}
