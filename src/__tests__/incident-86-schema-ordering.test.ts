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
 * não existir no schema aplicado, nenhum caminho de autenticação a pode exigir.
 * Quando o redesign chegar, chega por EXPAND → MIGRATE → RUNTIME → CONTRACT, e
 * estes testes mudam **depois** de a coluna existir — nunca antes.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

/** Os ficheiros por onde passa todo o login. Se um deles exigir a coluna, ninguém entra. */
const CAMINHOS_DE_AUTENTICACAO = [
  "src/lib/auth/current-user.ts",
  "src/lib/auth-guard.ts",
  "src/lib/supabase/middleware.ts",
  "src/app/(dashboard)/layout.tsx",
  "src/app/page.tsx",
];

/** As migrations que o runner aplica. `migration-drafts/` não conta — é o ponto. */
function colunasAplicadasDeProfiles(): string {
  const dir = path.join(ROOT, "supabase", "migrations");
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
    .join("\n");
}

/** A coluna ja existe numa migration que o runner aplica? */
function authUserIdEstaAplicada(): boolean {
  const aplicado = colunasAplicadasDeProfiles();
  return /alter\s+table\s+(public\.)?profiles[\s\S]{0,200}?auth_user_id/i.test(aplicado)
    || /create\s+table[^;]*profiles[\s\S]*?auth_user_id/i.test(aplicado);
}

describe("incidente #86 — ordem entre runtime e schema", () => {
  it("nenhum caminho de autenticação lê uma coluna que as migrations não criam", () => {
    const temAuthUserId = authUserIdEstaAplicada();

    // Enquanto a coluna não estiver numa migration aplicada, nenhum destes
    // ficheiros a pode nomear. Quando estiver, esta asserção deixa de se
    // aplicar sozinha — e é isso que a torna uma guarda de ordem, não um veto.
    if (temAuthUserId) return;

    const infractores = CAMINHOS_DE_AUTENTICACAO.filter((f) => read(f).includes("auth_user_id"));
    expect(infractores).toEqual([]);
  });

  it("getCurrentProfile procura o perfil pela chave que o schema tem hoje", () => {
    // 🔴 ESTE ENSAIO TEM A MESMA SAIDA CONDICIONAL DO PRIMEIRO, e passou a
    //    te-la porque o cabecalho deste ficheiro sempre o prometeu:
    //
    //      «Quando o redesign chegar, chega por EXPAND -> MIGRATE -> RUNTIME
    //       -> CONTRACT, e estes testes mudam DEPOIS de a coluna existir.»
    //
    //    A coluna existe desde a 101b, aplicada em producao. O que era uma
    //    guarda de ORDEM estava escrito como um veto permanente a convencao
    //    nova — e, a partir da 106-B, proibia precisamente o comportamento
    //    correcto: `criarAcesso()` grava a conta nova em `auth_user_id` e nao
    //    mexe em `profiles.id`, por isso procurar so pelo `id` deixaria de
    //    encontrar quem receba acesso de agora em diante.
    //
    //    O invariante que interessa nao mudou: o runtime nao pode exigir o que
    //    o schema nao tem. So que agora tem, e o que se exige e a PRECEDENCIA
    //    certa — a mesma de `public.get_my_profile_id()`.
    const fonte = read("src/lib/auth/current-user.ts");
    const resolvedor = read("src/lib/auth/resolve-profile.ts");

    if (!authUserIdEstaAplicada()) {
      // `profiles.id` e a chave primaria e e igual ao `auth.uid()` — era o
      // modelo que producao tinha. Troca-lo sem migrar primeiro foi o
      // incidente.
      expect(fonte).toMatch(/\.eq\(\s*["']id["']\s*,\s*user\.id\s*\)/);
      expect(fonte).not.toMatch(/\.eq\(\s*["']auth_user_id["']/);
      return;
    }

    // 🔴 A coluna existe: exige-se o caminho unico, e a ordem certa nele.
    expect(fonte).toContain("resolverPerfilAutenticado");
    // O ficheiro do login deixou de ter consulta propria de identidade.
    expect(fonte).not.toMatch(/\.eq\(\s*["'](id|auth_user_id)["']/);

    // E no resolvedor, a ligacao explicita e perguntada ANTES da legada.
    //
    // 🔴 Sem comentarios. A primeira ocorrencia de `.eq("id"` no ficheiro
    //    esta dentro do cabecalho, a explicar porque e que NAO pode ser so
    //    isso — o ensaio estaria a medir a documentacao em vez do codigo.
    const codigo = resolvedor
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const iLigacao = codigo.indexOf('.eq("auth_user_id"');
    const iLegado  = codigo.indexOf('.eq("id"');
    expect(iLigacao).toBeGreaterThan(-1);
    expect(iLegado).toBeGreaterThan(-1);
    expect(iLigacao).toBeLessThan(iLegado);
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
    const fonte = read("src/lib/auth/current-user.ts");
    const interface_ = fonte.slice(fonte.indexOf("interface CurrentProfile"),
      fonte.indexOf("}", fonte.indexOf("interface CurrentProfile")));
    // 🔴 A lista de campos mudou de sitio — passou a ser o argumento do
    //    resolvedor central — mas o invariante e o mesmo: um campo no tipo que
    //    a consulta nao traz chega ao codigo como `undefined` sem ninguem
    //    reparar. Foi assim que `auth_user_id` entrou.
    const select =
      (fonte.match(/\.select\(\s*["']([^"']+)["']/) ?? [])[1]
      ?? (fonte.match(/resolverPerfilAutenticado[\s\S]*?,\s*["']([^"']+)["']\s*\)/) ?? [])[1]
      ?? "";
    expect(select).not.toBe("");
    const pedidos = select.split(",").map((c) => c.trim()).filter(Boolean);
    const prometidos = [...interface_.matchAll(/^\s*(\w+)\s*[?:]/gm)].map((m) => m[1]);
    // Um campo no tipo que a consulta não traz chega ao código como
    // `undefined` sem ninguém reparar — foi assim que `auth_user_id` entrou.
    for (const campo of prometidos) expect(pedidos).toContain(campo);
  });
});
