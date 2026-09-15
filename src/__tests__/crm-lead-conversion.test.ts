// ============================================================================
// CRM — o mapeamento da lead para cliente, em código puro
// ============================================================================
//
// A parte que toca na base (idempotência, transação) está em
// `crm-conversion.pg.test.ts`. Aqui prova-se a tradução entre os dois
// vocabulários — que é onde a informação se perde por descuido.
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  leadParaClienteComLocal,
  porqueNaoConverte,
  precoHoraDoOrcamento,
  type LeadParaConverter,
} from "@/lib/crm/lead-to-cliente";

const LEAD: LeadParaConverter = {
  name: "  Condomínio Parque das Nações  ",
  lead_type: "empresa",
  contact_name: "António Silva",
  email: "antonio@condominio-pn.pt",
  phone: "912345678",
  nif: "501234567",
  address: "Rua das Nações, 12, Lisboa",
  lat: 38.76,
  lng: -9.09,
  service_type: "manutencao",
};

describe("CRM — da lead ao cliente: os campos não se perdem", () => {
  it("leva tudo o que o comercial escreveu", () => {
    const r = leadParaClienteComLocal(LEAD);

    expect(r.name).toBe("Condomínio Parque das Nações");   // aparado
    expect(r.type).toBe("empresa");
    expect(r.phone).toBe("912345678");
    expect(r.email).toBe("antonio@condominio-pn.pt");
    expect(r.nif).toBe("501234567");
    expect(r.address).toBe("Rua das Nações, 12, Lisboa");
    expect(r.lat).toBe(38.76);
    expect(r.lng).toBe(-9.09);
    expect(r.serviceType).toBe("manutencao");
  });

  it("campos vazios viajam como undefined, não como string vazia", () => {
    // É `undefined` que `createClienteComLocal` converte em NULL. Uma string
    // vazia gravaria um email em branco que depois parece um email.
    const r = leadParaClienteComLocal({
      ...LEAD,
      email: null,
      phone: "   ",
      nif: null,
    });
    expect(r.email).toBeUndefined();
    expect(r.phone).toBeUndefined();
    expect(r.nif).toBeUndefined();
  });

  it("o nome do local é o nome da lead", () => {
    // Não há melhor candidato no momento da conversão, e um local sem nome
    // aparece em branco no calendário e na escala.
    const r = leadParaClienteComLocal(LEAD);
    expect(r.locationName).toBe("Condomínio Parque das Nações");
  });

  it("sem tipo de serviço, fica limpeza regular", () => {
    const r = leadParaClienteComLocal({ ...LEAD, service_type: null });
    expect(r.serviceType).toBe("limpeza_regular");
  });

  it("um particular continua particular", () => {
    // `lead_type` usa o vocabulário de `clients.type` de propósito: sem isso,
    // a conversão teria de traduzir, e uma tradução é um sítio para errar.
    const r = leadParaClienteComLocal({ ...LEAD, lead_type: "individual" });
    expect(r.type).toBe("individual");
  });
});

describe("CRM — o preço/hora sai do orçamento", () => {
  it("vem da linha cobrada à hora", () => {
    expect(
      precoHoraDoOrcamento([
        { unit: "servico", unit_price: 80 },
        { unit: "hora", unit_price: 12.5 },
      ]),
    ).toBe(12.5);
  });

  it("🔴 sem linha à hora, é null — não se inventa um valor", () => {
    // Um preço/hora errado no local entraria no cálculo de cada serviço
    // gerado dali em diante, e ninguém ligaria o engano à conversão.
    expect(precoHoraDoOrcamento([{ unit: "servico", unit_price: 300 }])).toBeNull();
    expect(precoHoraDoOrcamento([])).toBeNull();
    expect(precoHoraDoOrcamento(undefined)).toBeNull();
  });

  it("um preço a zero não conta como preço", () => {
    expect(precoHoraDoOrcamento([{ unit: "hora", unit_price: 0 }])).toBeNull();
  });

  it("com várias linhas à hora, vale a primeira", () => {
    expect(
      precoHoraDoOrcamento([
        { unit: "hora", unit_price: 12 },
        { unit: "hora", unit_price: 15 },
      ]),
    ).toBe(12);
  });

  it("o preço/hora chega ao local", () => {
    const r = leadParaClienteComLocal(LEAD, { items: [{ unit: "hora", unit_price: 11 }] });
    expect(r.hourlyRate).toBe(11);
  });
});

describe("CRM — a morada da visita ganha à da lead", () => {
  it("quando existe, é a que vai para o local", () => {
    // A lead costuma ter a morada da sede; a visita tem a do sítio onde se vai
    // limpar, que é a que interessa ao mapa, ao GPS e ao clock-in.
    const r = leadParaClienteComLocal(LEAD, { visitAddress: "Av. do Mar, 4, Alverca" });
    expect(r.address).toBe("Av. do Mar, 4, Alverca");
  });

  it("uma morada de visita em branco não apaga a da lead", () => {
    const r = leadParaClienteComLocal(LEAD, { visitAddress: "   " });
    expect(r.address).toBe("Rua das Nações, 12, Lisboa");
  });
});

describe("CRM — o que impede converter", () => {
  it("🔴 sem morada, não avança", () => {
    // `locations.address` é NOT NULL, e um local sem morada não se encontra no
    // mapa nem valida o GPS. Melhor parar com uma frase do que criar um
    // cliente que já nasce partido.
    const motivo = porqueNaoConverte({ ...LEAD, address: null });
    expect(motivo).toContain("morada");
  });

  it("uma morada só na visita chega", () => {
    expect(
      porqueNaoConverte({ ...LEAD, address: null }, { visitAddress: "Rua X, 1" }),
    ).toBeNull();
  });

  it("sem nome, não avança", () => {
    expect(porqueNaoConverte({ ...LEAD, name: "   " })).toContain("nome");
  });

  it("com nome e morada, avança", () => {
    expect(porqueNaoConverte(LEAD)).toBeNull();
  });

  it("a mensagem diz o que fazer, não o que falhou", () => {
    const motivo = porqueNaoConverte({ ...LEAD, address: null });
    expect(motivo).toMatch(/Acrescente/i);
    // Nada de nomes de tabelas ou colunas no ecrã.
    expect(motivo).not.toMatch(/locations|NOT NULL|column/i);
  });
});

describe("CRM — a fronteira da conversão", () => {
  const ROOT = process.cwd();
  const ACTION = readFileSync(join(ROOT, "src/app/actions/crm-conversao.ts"), "utf8");
  const semComentarios = ACTION.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("🔴 a conversão não cria contratos nem serviços", () => {
    // Foi decisão explícita do dono: o formulário abre pré-preenchido e o
    // gestor confirma. Nada entra no calendário sozinho.
    for (const tabela of ["contracts", "services", "invoices", "cash_flow_entries"]) {
      expect(semComentarios, `a conversão não pode escrever em ${tabela}`)
        .not.toContain(`.from("${tabela}")`);
    }
  });

  it("🔴 não cria o cliente antes da RPC — foi esse o defeito da primeira versão", () => {
    // A versão anterior chamava `createClienteComLocal`, que COMMITAVA o
    // cliente e o local antes de a RPC correr. Em concorrência, dois pedidos
    // criavam dois clientes antes de qualquer um chegar à RPC; a RPC rejeitava
    // o segundo e o cliente dele ficava lá.
    //
    // A action deixou de criar seja o que for: a RPC recebe os DADOS.
    expect(semComentarios).not.toContain("createClienteComLocal(");
    expect(semComentarios).not.toContain('.from("clients")');
    expect(semComentarios).not.toContain('.from("locations")');
    expect(semComentarios).not.toMatch(/\.insert\(/);
  });

  it("converte por RPC, e é a RPC nova", () => {
    expect(semComentarios).toContain("convert_crm_lead_atomic");
    // A assinatura antiga não pode voltar a aparecer: era o caminho que
    // commitava antes de converter.
    expect(semComentarios).not.toContain("link_crm_lead_conversion");
  });

  it("os dados que a RPC recebe saem do mapeamento puro", () => {
    // Se a action passasse valores construídos à mão, o mapeamento testado
    // acima deixaria de ser o que chega à base.
    expect(semComentarios).toContain("leadParaClienteComLocal");
    expect(semComentarios).toContain("entrada.address");
    expect(semComentarios).toContain("entrada.hourlyRate");
  });

  it("revalida os três domínios que a conversão muda", () => {
    expect(semComentarios).toMatch(/domains:\s*\["leads",\s*"clients",\s*"locations"\]/);
  });

  it("🔴 só converte a partir de um orçamento aceite", () => {
    expect(semComentarios).toContain('q.status !== "aceite"');
  });
});
