import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  SW_LAST_ACCEPTED_KEY,
  getLastAcceptedVersion,
  setLastAcceptedVersion,
  shouldShowUpdatePrompt,
  createOnceGuard,
  type MinimalStorage,
} from "@/lib/sw-update";

const ROOT = join(__dirname, "..", "..");

// Cobre o bug real de produção: o aviso de atualização do PWA repetia-se
// para a MESMA versão (ver src/lib/sw-update.ts para a análise completa) e
// nada impedia mais de um reload por atualização. Este ficheiro testa só a
// lógica pura — a parte que fala com o service worker/DOM fica em
// src/lib/hooks/use-service-worker-update.ts, sem teste dedicado (mesmo
// padrão de src/lib/hooks/use-single-flight.ts, sem DOM disponível aqui:
// vitest.config.ts corre em ambiente "node").

function fakeStorage(initial: Record<string, string> = {}): MinimalStorage {
  const store = { ...initial };
  return {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => {
      store[key] = value;
    },
  };
}

describe("getLastAcceptedVersion / setLastAcceptedVersion", () => {
  it("devolve null quando nunca foi guardada nenhuma versão", () => {
    expect(getLastAcceptedVersion(fakeStorage())).toBeNull();
  });

  it("guarda e depois lê a mesma versão", () => {
    const storage = fakeStorage();
    setLastAcceptedVersion(storage, "11cdea7");
    expect(getLastAcceptedVersion(storage)).toBe("11cdea7");
  });

  it("usa a chave documentada (SW_LAST_ACCEPTED_KEY), não uma string solta", () => {
    const storage = fakeStorage();
    setLastAcceptedVersion(storage, "abc1234");
    expect(storage.getItem(SW_LAST_ACCEPTED_KEY)).toBe("abc1234");
  });

  it("guardar uma versão nova substitui a anterior", () => {
    const storage = fakeStorage({ [SW_LAST_ACCEPTED_KEY]: "11cdea7" });
    setLastAcceptedVersion(storage, "abc1234");
    expect(getLastAcceptedVersion(storage)).toBe("abc1234");
  });

  it("getLastAcceptedVersion nunca lança, mesmo se o storage rebentar (ex.: modo privado)", () => {
    const broken: MinimalStorage = {
      getItem: () => {
        throw new Error("storage bloqueado");
      },
      setItem: () => {},
    };
    expect(() => getLastAcceptedVersion(broken)).not.toThrow();
    expect(getLastAcceptedVersion(broken)).toBeNull();
  });

  it("setLastAcceptedVersion nunca lança, mesmo com quota esgotada", () => {
    const broken: MinimalStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota esgotada");
      },
    };
    expect(() => setLastAcceptedVersion(broken, "11cdea7")).not.toThrow();
  });
});

describe("shouldShowUpdatePrompt — nunca repete o aviso para a mesma versão", () => {
  it("não mostra sem versão em espera (ainda não determinada)", () => {
    expect(shouldShowUpdatePrompt(null, null)).toBe(false);
    expect(shouldShowUpdatePrompt(undefined, "11cdea7")).toBe(false);
    expect(shouldShowUpdatePrompt("", "11cdea7")).toBe(false);
  });

  it("mostra quando há versão em espera e nada foi aceite ainda (1ª atualização)", () => {
    expect(shouldShowUpdatePrompt("11cdea7", null)).toBe(true);
  });

  it("NÃO mostra outra vez para a mesma versão já aceite — o caso central do bug", () => {
    expect(shouldShowUpdatePrompt("11cdea7", "11cdea7")).toBe(false);
  });

  it("mostra quando a versão em espera é DIFERENTE da última aceite (commit novo real)", () => {
    expect(shouldShowUpdatePrompt("abc1234", "11cdea7")).toBe(true);
  });

  it("fluxo completo: aceitar 11cdea7, depois recarregar — não volta a mostrar para 11cdea7, mas mostra para abc1234", () => {
    const storage = fakeStorage();
    // 1ª atualização: 11cdea7 aparece, é aceite.
    expect(shouldShowUpdatePrompt("11cdea7", getLastAcceptedVersion(storage))).toBe(true);
    setLastAcceptedVersion(storage, "11cdea7");

    // "Recarrega" — simula o service worker continuar a reportar a mesma
    // versão como waiting por qualquer motivo de timing (exatamente o
    // cenário que causava o aviso repetido em produção).
    expect(shouldShowUpdatePrompt("11cdea7", getLastAcceptedVersion(storage))).toBe(false);

    // Um commit novo real chega — o aviso deve voltar.
    expect(shouldShowUpdatePrompt("abc1234", getLastAcceptedVersion(storage))).toBe(true);
  });
});

describe("createOnceGuard — nunca executa duas vezes (protege contra loop de reload)", () => {
  it("a primeira chamada a run() executa a função", () => {
    const guard = createOnceGuard();
    const fn = vi.fn();
    guard.run(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("chamadas repetidas a run() só executam a função uma vez", () => {
    const guard = createOnceGuard();
    const fn = vi.fn();
    guard.run(fn);
    guard.run(fn);
    guard.run(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("hasRun() reflete o estado corretamente antes e depois", () => {
    const guard = createOnceGuard();
    expect(guard.hasRun()).toBe(false);
    guard.run(() => {});
    expect(guard.hasRun()).toBe(true);
  });

  it("simula o cenário real: controllerchange e o fallback de 3s disputando o mesmo reload — só um reload acontece", () => {
    const guard = createOnceGuard();
    const reload = vi.fn();

    // controllerchange dispara primeiro
    guard.run(reload);
    // fallback de 3s dispara depois, mesmo já sendo tarde de mais
    guard.run(reload);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("guardas independentes (ex.: duas atualizações sucessivas) não interferem entre si", () => {
    const guardA = createOnceGuard();
    const guardB = createOnceGuard();
    const fnA = vi.fn();
    const fnB = vi.fn();

    guardA.run(fnA);
    guardB.run(fnB);
    guardA.run(fnA);
    guardB.run(fnB);

    expect(fnA).toHaveBeenCalledTimes(1);
    expect(fnB).toHaveBeenCalledTimes(1);
  });
});

// ── Invariantes estáticas — fixam a causa-raiz corrigida nesta sessão. Se
//    um destes falhar, alguém reintroduziu o bug do aviso repetido.
//    (mesmo padrão de src/__tests__/reversao-guards.test.ts)
describe("scripts/stamp-sw.mjs — versão do service worker nunca usa Date.now()", () => {
  const script = readFileSync(join(ROOT, "scripts", "stamp-sw.mjs"), "utf8");

  it("não usa Date.now() para gerar a versão — cada build sem código novo gerava um aviso falso", () => {
    // Remove comentários antes de verificar: o ficheiro documenta o bug
    // antigo em prosa (que citava Date.now() como exemplo do que NÃO fazer),
    // isso não pode ser confundido com o código continuar a chamá-lo.
    const codeOnly = script
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(codeOnly).not.toContain("Date.now()");
  });

  it("usa VERCEL_GIT_COMMIT_SHA como (única) fonte da versão", () => {
    expect(script).toContain("VERCEL_GIT_COMMIT_SHA");
    expect(script).toMatch(/const version = sha;/);
  });

  it("sem SHA disponível, não estampa nada (nunca cai de volta para timestamp)", () => {
    expect(script).toMatch(/if \(!sha\)/);
  });
});

describe("public/sw.js — responde à pergunta de versão (GET_VERSION)", () => {
  const sw = readFileSync(join(ROOT, "public", "sw.js"), "utf8");

  it("trata GET_VERSION e responde pela MessageChannel recebida (e.ports[0])", () => {
    expect(sw).toContain('e.data.type === "GET_VERSION"');
    expect(sw).toMatch(/e\.ports\[0\]\.postMessage\(\{\s*version:\s*CACHE\s*\}\)/);
  });

  it("continua a tratar SKIP_WAITING (não regrediu o comportamento existente)", () => {
    expect(sw).toContain('e.data === "SKIP_WAITING"');
  });
});
