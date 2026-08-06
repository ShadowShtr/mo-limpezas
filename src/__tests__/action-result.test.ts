// ============================================================================
// Formato único de resultado das Server Actions — Task T05
// ============================================================================
// Cobre o contrato (`src/lib/action-result.ts`) e o piloto
// (`saveCompanySettings`).
//
// O que estes testes protegem, por ordem de importância:
//   1. um erro interno do Supabase nunca chega ao ecrã do utilizador;
//   2. os códigos de erro são estáveis, para a interface poder ramificar por
//      `code` sem depender do texto da mensagem;
//   3. sucesso e falha distinguem-se por `ok`, nunca por presença de campos;
//   4. o piloto mantém as mensagens visíveis que já existiam.
// ============================================================================

import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";

import {
  ACTION_ERROR_CODES,
  actionFailure,
  actionSuccess,
  internalFailure,
  validationFailure,
  type ActionResult,
} from "@/lib/action-result";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("actionSuccess", () => {
  it("preserva o tipo e o valor de data", () => {
    const resultado = actionSuccess({ vat_rate: 23, prefixo: "F" });

    expect(resultado.ok).toBe(true);
    expect(resultado.data).toEqual({ vat_rate: 23, prefixo: "F" });
  });

  it("preserva valores que não são objetos, incluindo os falsy", () => {
    expect(actionSuccess(0).data).toBe(0);
    expect(actionSuccess("").data).toBe("");
    expect(actionSuccess(false).data).toBe(false);
    expect(actionSuccess(null).data).toBeNull();
  });

  it("não traz campo de erro nenhum", () => {
    const resultado = actionSuccess("x");

    expect(Object.keys(resultado).sort()).toEqual(["data", "ok"]);
    expect("error" in resultado).toBe(false);
  });
});

describe("actionFailure", () => {
  it("tem código estável e mensagem legível", () => {
    const resultado = actionFailure(
      ACTION_ERROR_CODES.FORBIDDEN,
      "Sem permissão para alterar configurações.",
    );

    expect(resultado.ok).toBe(false);
    expect(resultado.error.code).toBe("FORBIDDEN");
    expect(resultado.error.message).toBe(
      "Sem permissão para alterar configurações.",
    );
  });

  it("fieldErrors é opcional — a chave nem existe quando não há", () => {
    const semCampos = actionFailure(ACTION_ERROR_CODES.CONFLICT, "Colidiu.");

    expect("fieldErrors" in semCampos.error).toBe(false);

    const comCampos = actionFailure(
      ACTION_ERROR_CODES.VALIDATION,
      "Inválido.",
      { vat_rate: ["IVA não pode ser negativo."] },
    );

    expect(comCampos.error.fieldErrors).toEqual({
      vat_rate: ["IVA não pode ser negativo."],
    });
  });

  it("não traz data — estados contraditórios não são representáveis", () => {
    const resultado = actionFailure(ACTION_ERROR_CODES.NOT_FOUND, "Sumiu.");

    expect(Object.keys(resultado).sort()).toEqual(["error", "ok"]);
    expect("data" in resultado).toBe(false);
  });

  it("todos os códigos declarados são únicos e iguais à sua chave", () => {
    // Se um código deixar de ser igual à chave, deixa de ser óbvio ao ler o
    // código-fonte qual o valor que a interface vai receber.
    const entradas = Object.entries(ACTION_ERROR_CODES);
    const valores = entradas.map(([, valor]) => valor);

    expect(new Set(valores).size).toBe(valores.length);

    for (const [chave, valor] of entradas) {
      expect(valor).toBe(chave);
    }
  });
});

describe("validationFailure", () => {
  const schema = z.object({
    vat_rate: z.number().min(0, "IVA não pode ser negativo."),
    invoice_prefix: z.string().min(1, "Prefixo obrigatório."),
  });

  it("usa o código VALIDATION e agrupa por campo", () => {
    const parsed = schema.safeParse({ vat_rate: -1, invoice_prefix: "" });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const resultado = validationFailure(parsed.error);

    expect(resultado.error.code).toBe("VALIDATION");
    expect(resultado.error.fieldErrors).toEqual({
      vat_rate: ["IVA não pode ser negativo."],
      invoice_prefix: ["Prefixo obrigatório."],
    });
  });

  it("a mensagem é a primeira, como a interface já mostrava", () => {
    const parsed = schema.safeParse({ vat_rate: -1, invoice_prefix: "F" });

    if (parsed.success) throw new Error("devia ter falhado");

    expect(validationFailure(parsed.error).error.message).toBe(
      "IVA não pode ser negativo.",
    );
  });

  it("aguenta um erro sem caminho de campo", () => {
    const resultado = validationFailure({
      issues: [{ path: [], message: "Entrada inválida." }],
    });

    expect(resultado.error.message).toBe("Entrada inválida.");
    expect("fieldErrors" in resultado.error).toBe(false);
  });
});

describe("internalFailure — o utilizador nunca vê o interior", () => {
  it("não deixa passar a mensagem do Supabase para a interface", () => {
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});

    const erroReal = {
      message:
        'duplicate key value violates unique constraint "company_settings_pkey"',
      details: 'Key (company_id)=(abc) already exists.',
      hint: null,
      code: "23505",
    };

    const resultado = internalFailure("saveCompanySettings", erroReal);

    const serializado = JSON.stringify(resultado);

    expect(serializado).not.toContain("company_settings_pkey");
    expect(serializado).not.toContain("duplicate key");
    expect(serializado).not.toContain("23505");
    expect(serializado).not.toContain("already exists");

    expect(resultado.error.message).toBe(
      "Não foi possível concluir a operação. Tenta novamente.",
    );

    // O detalhe real não se perde: vai para o log do servidor.
    expect(consola).toHaveBeenCalledWith("[action:saveCompanySettings]", erroReal);
  });

  it("aceita distinguir falha de persistência de falha inesperada", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(internalFailure("x", new Error("y")).error.code).toBe("INTERNAL");
    expect(
      internalFailure("x", new Error("y"), ACTION_ERROR_CODES.PERSISTENCE).error
        .code,
    ).toBe("PERSISTENCE");
  });

  it("não expõe o stack trace de uma exceção", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const resultado = internalFailure("x", new Error("segredo interno"));

    expect(JSON.stringify(resultado)).not.toContain("segredo interno");
  });
});

describe("consumidores distinguem sucesso de erro por result.ok", () => {
  function consumir(resultado: ActionResult<number>): string {
    // O padrão que a interface deve seguir. Dentro do `if`, o TypeScript sabe
    // que `data` existe; fora dele, sabe que `error` existe.
    if (resultado.ok) return `sucesso:${resultado.data}`;
    return `erro:${resultado.error.code}`;
  }

  it("estreita o tipo corretamente nos dois ramos", () => {
    expect(consumir(actionSuccess(7))).toBe("sucesso:7");
    expect(
      consumir(actionFailure(ACTION_ERROR_CODES.FORBIDDEN, "Não podes.")),
    ).toBe("erro:FORBIDDEN");
  });
});

describe("piloto — saveCompanySettings", () => {
  const acao = "src/app/actions/settings.ts";

  it("adota o formato único e não devolve o erro cru do Supabase", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");

    const conteudo = fs
      .readFileSync(path.join(__dirname, "..", "..", acao), "utf8")
      .replace(/\r\n/g, "\n");

    expect(conteudo).toContain('from "@/lib/action-result"');
    expect(conteudo).toContain("ActionResult<CompanySettings>");

    // O defeito que o piloto corrige: nenhuma devolução do `message` do erro
    // do Supabase para a interface.
    expect(conteudo).not.toMatch(/error:\s*error\.message/);

    // E nenhum resto do formato antigo nesta action.
    expect(conteudo).not.toMatch(/ok:\s*false as const/);
    expect(conteudo).not.toMatch(/ok:\s*true as const/);
  });

  it("o consumidor lê a mensagem do sítio novo", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");

    const consumidor = fs
      .readFileSync(
        path.join(
          __dirname,
          "..",
          "app",
          "(dashboard)",
          "dashboard",
          "configuracoes",
          "_components",
          "settings-form.tsx",
        ),
        "utf8",
      )
      .replace(/\r\n/g, "\n");

    expect(consumidor).toContain("res.error.message");
    // A mensagem de sucesso visível não mudou.
    expect(consumidor).toContain("Configurações guardadas com sucesso.");
  });
});

describe("não existe um segundo formato paralelo", () => {
  it("action-result.ts é o único módulo a declarar ActionResult", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");

    const raiz = path.join(__dirname, "..");
    const encontrados: string[] = [];

    const percorrer = (dir: string) => {
      for (const nome of fs.readdirSync(dir)) {
        const p = path.join(dir, nome);
        if (fs.statSync(p).isDirectory()) {
          // Os próprios testes citam o padrão que procuram — incluí-los faria
          // a varredura encontrar-se a si mesma.
          if (nome !== "__tests__") percorrer(p);
          continue;
        }
        if (/\.tsx?$/.test(nome)) {
          const conteudo = fs.readFileSync(p, "utf8");
          if (/export type ActionResult\b/.test(conteudo)) {
            encontrados.push(path.relative(raiz, p).split(path.sep).join("/"));
          }
        }
      }
    };

    percorrer(raiz);

    expect(encontrados).toEqual(["lib/action-result.ts"]);
  });
});
