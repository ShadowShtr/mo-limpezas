// ============================================================================
// notifyUser — o canal durável passa a saber se gravou
// ============================================================================
//
// 🔴 A função dizia que o in-app era «o canal garantido» e não tinha como
//    saber se a gravação passou: o INSERT terminava em
//    `.then(() => null, () => null)`, com sucesso e erro descartados no mesmo
//    gesto. Para um cron diário isso é o defeito inteiro — ninguém está a ver,
//    e um 200 sem ter gravado nada é pior do que uma falha.
// ============================================================================

import { describe, expect, it, vi, beforeEach } from "vitest";
import { notifyUser } from "@/lib/push-notify";

interface Estado {
  insertErro: string | null;
  insertLanca: boolean;
  subs: unknown[];
  inserts: Record<string, unknown>[];
}

let estado: Estado;

function admin() {
  return {
    from(tabela: string) {
      if (tabela === "notifications") {
        return {
          insert(linha: Record<string, unknown>) {
            if (estado.insertLanca) throw new Error("ligação caiu");
            estado.inserts.push(linha);
            return Promise.resolve(
              estado.insertErro ? { error: { message: estado.insertErro } } : { error: null },
            );
          },
        };
      }
      const api = {
        select: () => api,
        eq: () => api,
        then: (r: (v: unknown) => unknown) => r({ data: estado.subs, error: null }),
      };
      return api;
    },
  } as never;
}

const args = {
  companyId: "empresa-1",
  userId: "perfil-1",
  type: "deadline_payment",
  title: "Seguro",
  body: "Hoje",
};

beforeEach(() => {
  estado = { insertErro: null, insertLanca: false, subs: [], inserts: [] };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("stored reflecte a gravação", () => {
  it("gravação bem sucedida devolve stored=true", async () => {
    const r = await notifyUser(admin(), args);
    expect(r.stored).toBe(true);
    expect(estado.inserts).toHaveLength(1);
  });

  it("erro do INSERT devolve stored=false", async () => {
    estado.insertErro = "permission denied";
    const r = await notifyUser(admin(), args);
    expect(r.stored).toBe(false);
  });

  it("uma excepção no INSERT devolve stored=false e NÃO lança", async () => {
    estado.insertLanca = true;
    await expect(notifyUser(admin(), args)).resolves.toMatchObject({ stored: false });
  });

  it("a falha é registada em log, não silenciada", async () => {
    estado.insertErro = "permission denied";
    await notifyUser(admin(), args);
    expect(console.error).toHaveBeenCalled();
  });

  it("grava o user_id tal como recebido, sem o traduzir", async () => {
    await notifyUser(admin(), args);
    expect(estado.inserts[0]).toMatchObject({ user_id: "perfil-1", company_id: "empresa-1" });
  });
});

describe("sem gravação não há Push", () => {
  // 🔴 Um Push sem linha no sino é um aviso que aparece no telemóvel e não
  //    existe em lado nenhum. E numa retry — que só olha para o que ficou
  //    GRAVADO — o mesmo aviso voltaria a ser empurrado a cada tentativa.
  it("falhar a gravar nem sequer procura subscrições", async () => {
    estado.insertErro = "indisponível";
    estado.subs = [{ endpoint: "https://e", p256dh: "k", auth_key: "a" }];
    const r = await notifyUser(admin(), args);
    expect(r).toEqual({ stored: false, notified: false });
  });
});

describe("retrocompatibilidade", () => {
  it("notified continua a significar o mesmo: sem subscrições, false", async () => {
    const r = await notifyUser(admin(), args);
    expect(r.notified).toBe(false);
  });

  it("o retorno continua a ter notified, para quem já o lia", async () => {
    const r = await notifyUser(admin(), args);
    expect(r).toHaveProperty("notified");
    expect(r).toHaveProperty("stored");
  });

  // Os chamadores existentes ignoram o retorno — continuam a funcionar sem
  // qualquer alteração, que é o requisito de compatibilidade.
  it("os chamadores actuais não leem o resultado", async () => {
    const fs = await import("node:fs");
    const fonte = fs.readFileSync("src/app/actions/management-tasks.ts", "utf8");
    expect(fonte).toContain("await notifyUser(admin, {");
    expect(fonte).not.toMatch(/=\s*await notifyUser/);
  });
});
