// ============================================================================
// MATRIZ DE INVALIDAÇÃO ENTRE DOMÍNIOS (Task T10)
// ============================================================================
// O buraco que esta matriz fecha: quem escreve uma action sabe o que mudou
// ("um contrato"), não necessariamente que ecrãs dependem disso. Era assim que
// nasciam as inconsistências — a alteração financeira de um contrato não
// revalidava /dashboard/cobrancas, e ninguém dava por isso até alguém reparar
// num número antigo no ecrã.
//
// Estes testes fixam as dependências INDIRETAS, que são precisamente as que se
// esquecem.
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  DOMAIN_SCOPES,
  scopesForDomains,
  type BusinessDomain,
  type BusinessScope,
} from "@/lib/revalidate-business";

const TODOS: BusinessDomain[] = [
  "contracts", "services", "clients", "locations",
  "teams", "collaborators", "invoices", "payments", "settings",
];

describe("cobertura da matriz", () => {
  it("todos os domínios têm ecrãs declarados", () => {
    for (const domain of TODOS) {
      expect(DOMAIN_SCOPES[domain], domain).toBeDefined();
      expect(DOMAIN_SCOPES[domain].length, domain).toBeGreaterThan(0);
    }
  });

  it("nenhum domínio se declara a si próprio duas vezes", () => {
    for (const domain of TODOS) {
      const scopes = DOMAIN_SCOPES[domain];
      expect(new Set(scopes).size, domain).toBe(scopes.length);
    }
  });
});

describe("dependências indiretas — as que se esquecem", () => {
  it("🔴 um contrato invalida as cobranças", () => {
    // O defeito histórico: alterar o valor de um contrato deixava
    // /dashboard/cobrancas a mostrar números antigos.
    expect(DOMAIN_SCOPES.contracts).toContain("cobrancas");
  });

  it("um contrato invalida o calendário — define ocorrências futuras", () => {
    expect(DOMAIN_SCOPES.contracts).toContain("calendario");
  });

  it("um serviço invalida cobranças e relatórios", () => {
    expect(DOMAIN_SCOPES.services).toContain("cobrancas");
    expect(DOMAIN_SCOPES.services).toContain("relatorios");
  });

  it("🔴 o valor/hora do local invalida o calendário", () => {
    // Entra no cálculo de cada serviço gerado a partir daquele local.
    expect(DOMAIN_SCOPES.locations).toContain("calendario");
    expect(DOMAIN_SCOPES.locations).toContain("contratos");
  });

  it("o tamanho da equipa invalida o calendário — multiplica o valor", () => {
    expect(DOMAIN_SCOPES.teams).toContain("calendario");
  });

  it("🔴 as configurações invalidam tudo o que calcula dinheiro", () => {
    // IVA, taxa horária e subsídio entram em todos os cálculos.
    for (const scope of ["relatorios", "financeiro", "cobrancas", "calendario"] as BusinessScope[]) {
      expect(DOMAIN_SCOPES.settings, scope).toContain(scope);
    }
  });

  it("o nome do cliente aparece no calendário e nas faturas", () => {
    expect(DOMAIN_SCOPES.clients).toContain("calendario");
    expect(DOMAIN_SCOPES.clients).toContain("cobrancas");
  });

  it("um pagamento invalida faturação e financeiro", () => {
    expect(DOMAIN_SCOPES.payments).toContain("cobrancas");
    expect(DOMAIN_SCOPES.payments).toContain("financeiro");
  });
});

describe("scopesForDomains", () => {
  it("junta sem repetir", () => {
    const scopes = scopesForDomains(["contracts", "services"]);
    expect(new Set(scopes).size).toBe(scopes.length);
    expect(scopes).toContain("calendario");
    expect(scopes).toContain("cobrancas");
  });

  it("é determinístico e ordenado", () => {
    const a = scopesForDomains(["services", "contracts"]);
    const b = scopesForDomains(["contracts", "services"]);
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual(a);
  });

  it("lista vazia não invalida nada", () => {
    expect(scopesForDomains([])).toEqual([]);
  });

  it("um domínio isolado não arrasta o resto da aplicação", () => {
    // Invalidação "nuclear" é tão problemática como a insuficiente: obriga a
    // aplicação inteira a refazer trabalho por qualquer alteração.
    const scopes = scopesForDomains(["teams"]);
    expect(scopes.length).toBeLessThan(5);
    expect(scopes).not.toContain("configuracoes");
  });

  it("nenhum domínio invalida todos os ecrãs", () => {
    const todos = new Set<BusinessScope>();
    for (const domain of TODOS) for (const s of DOMAIN_SCOPES[domain]) todos.add(s);
    for (const domain of TODOS) {
      expect(DOMAIN_SCOPES[domain].length, domain).toBeLessThan(todos.size);
    }
  });

  it("domínios repetidos não duplicam ecrãs", () => {
    expect(scopesForDomains(["contracts", "contracts"]))
      .toEqual(scopesForDomains(["contracts"]));
  });
});
