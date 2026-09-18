/**
 * Incidente #86 — o runtime não pode exigir uma coluna que o schema não tem.
 *
 * A PR #86 mudou `getCurrentProfile` de
 *
 *     .eq("id", user.id)      →      .eq("auth_user_id", user.id)
 *
 * e trouxe a coluna `auth_user_id` numa migration **draft**, que por desenho
 * não é aplicada por nenhum runner. O merge disparou auto-deploy: o runtime
 * passou a interrogar produção por uma coluna que lá não estava, e a consulta
 * do perfil passou a devolver nada — para toda a gente, admin incluído.
 *
 * O login não «ficou lento» nem «falhou às vezes»: deixou de haver perfil, e
 * com ele o papel, a empresa e o acesso ao dashboard.
 *
 * Este ficheiro não testa colaboradores. Testa a **ordem**: enquanto a coluna
 * não existir no schema aplicado, nenhum caminho de autenticação pode depender
 * dela. Quando o redesign chegar, chega por EXPAND → MIGRATE → RUNTIME →
 * CONTRACT, e estes testes mudam **depois** de a coluna existir — nunca antes.
 *
 * ---------------------------------------------------------------------------
 * 🔴 Actualizado a 2026-09-17, com a migration 102.
 * ---------------------------------------------------------------------------
 *
 * Duas coisas mudaram, e nenhuma afrouxa o guard:
 *
 *   1. A consulta do perfil mudou-se para
 *      `src/lib/collaborators/current-profile-resolver.ts`. Um guard que só
 *      olhasse para os ficheiros antigos passaria a dar verde por já não estar
 *      a ver nada — o pior modo de falha que um invariante tem. Segue o código.
 *
 *   2. A regra passou de «não pode NOMEAR a coluna» para «não pode DEPENDER
 *      dela». Em #86 a consulta FALHAVA sem a coluna; o resolver de hoje trata
 *      `42703` e resolve pelo `id` na mesma. Proibir a palavra fechava o
 *      incidente, mas proibia também o código que sobrevive à ausência — e o
 *      que interessa medir é a sobrevivência, não o vocabulário.
 *
 * Nota de facto, apurada por leitura read-only de produção: a coluna EXISTE na
 * base real. Chegou lá por fora do runner, e continua sem migration aplicada
 * neste repositório. É precisamente por isso que o guard se mantém.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

/** Onde a consulta do perfil vive hoje. */
const RESOLVER = "src/lib/collaborators/current-profile-resolver.ts";

/** Os ficheiros por onde passa todo o login. Se um deles exigir a coluna, ninguém entra. */
const CAMINHOS_DE_AUTENTICACAO = [
  "src/lib/auth/current-user.ts",
  "src/lib/auth-guard.ts",
  "src/lib/supabase/middleware.ts",
  "src/app/(dashboard)/layout.tsx",
  "src/app/page.tsx",
  RESOLVER,
];

/** As migrations que o runner aplica. `migration-drafts/` não conta — é o ponto. */
function colunasAplicadasDeProfiles(): string {
  const dir = path.join(ROOT, "supabase", "migrations");
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
    .join("\n");
}

describe("incidente #86 — ordem entre runtime e schema", () => {
  it("nenhum caminho de autenticação DEPENDE de uma coluna que as migrations não criam", () => {
    const aplicado = colunasAplicadasDeProfiles();
    const temAuthUserId = /alter\s+table\s+(public\.)?profiles[\s\S]{0,200}?auth_user_id/i.test(aplicado)
      || /create\s+table[^;]*profiles[\s\S]*?auth_user_id/i.test(aplicado);

    // Quando a coluna passar a ser criada por uma migration aplicada, esta
    // asserção deixa de se aplicar sozinha — é isso que a torna uma guarda de
    // ordem, e não um veto permanente.
    if (temAuthUserId) return;

    const infractores = CAMINHOS_DE_AUTENTICACAO.filter((f) => {
      const fonte = read(f);
      if (!fonte.includes("auth_user_id")) return false;
      // `42703` é o código do PostgREST para «essa coluna não existe». Quem
      // nomeia a coluna tem de o tratar, e resolver na mesma.
      return !fonte.includes("42703");
    });

    expect(
      infractores,
      "um caminho de autenticação que nomeie auth_user_id tem de tolerar a ausência da coluna (42703)",
    ).toEqual([]);
  });

  it("o perfil é resolvido PRIMEIRO por `id` — a chave que o schema garante", () => {
    const fonte = read(RESOLVER);

    // `profiles.id` é a chave primária e é igual ao `auth.uid()` — é o modelo
    // que produção tem (`auth_user_id != id` = 0 linhas). Trocar a ordem sem
    // migrar primeiro foi exactamente o incidente.
    const porId = fonte.indexOf('.eq("id", authUserId)');
    const porColuna = fonte.indexOf('.eq("auth_user_id", authUserId)');

    expect(porId, "o resolver tem de procurar por id").toBeGreaterThan(-1);
    expect(porColuna, "a consulta por auth_user_id tem de vir DEPOIS").toBeGreaterThan(porId);
  });

  it("nenhum outro caminho de autenticação faz a consulta por sua conta", () => {
    // Quatro sítios a resolver o mesmo perfil de quatro maneiras foi como as
    // regras divergiram — e como `status` ficou de fora de três delas. Agora há
    // um resolver, e os outros chamam-no.
    //
    // O middleware fica de fora: corre no Edge, com o cliente do utilizador e
    // sem a chave administrativa, por isso não pode usar o resolver.
    const duplicados = CAMINHOS_DE_AUTENTICACAO
      .filter((f) => f !== RESOLVER && f !== "src/lib/supabase/middleware.ts")
      .filter((f) => /\.from\(\s*["']profiles["']\s*\)[\s\S]{0,300}?\.eq\(\s*["']id["']\s*,\s*user\.id/.test(read(f)));

    expect(duplicados).toEqual([]);
  });

  it("uma migration draft não é uma migration aplicada", () => {
    const drafts = path.join(ROOT, "supabase", "migration-drafts");
    const draftsF14 = path.join(ROOT, "supabase", "migrations", "draft");
    // As duas pastas de rascunho existem para trabalho preparado e não aplicado.
    // O runner lê `supabase/migrations/*.sql` e mais nada: qualquer runtime que
    // dependa do que está em rascunho está a depender de algo que não existe.
    for (const dir of [drafts, draftsF14]) {
      if (!fs.existsSync(dir)) continue;
      const naRaiz = fs.readdirSync(path.join(ROOT, "supabase", "migrations"))
        .filter((f) => f.endsWith(".sql"));
      const emRascunho = fs.readdirSync(dir).filter((f) => f.endsWith(".sql"));
      for (const f of emRascunho) expect(naRaiz).not.toContain(f);
    }
  });

  it("o perfil devolvido pelo runtime não promete campos que a consulta não pede", () => {
    const fonte = read(RESOLVER);
    const inicio = fonte.indexOf("interface PerfilAutenticado");
    const interface_ = fonte.slice(inicio, fonte.indexOf("\n}", inicio));
    const select = (fonte.match(/\.select\(\s*["']([^"']+)["']/) ?? [])[1] ?? "";
    const pedidos = select.split(",").map((c) => c.trim()).filter(Boolean);
    const prometidos = [...interface_.matchAll(/^\s*(\w+)\s*[?:]\s*string/gm)].map((m) => m[1]);
    // Um campo no tipo que a consulta não traz chega ao código como
    // `undefined` sem ninguém reparar — foi assim que `auth_user_id` entrou.
    expect(prometidos.length).toBeGreaterThan(0);
    for (const campo of prometidos) expect(pedidos).toContain(campo);
  });
});
