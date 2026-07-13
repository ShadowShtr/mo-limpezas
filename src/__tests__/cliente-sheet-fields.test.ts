import { describe, it, expect } from "vitest";
import { CLIENTE_SHEET_SELECT } from "@/lib/cliente-sheet-fields";

// Regressão do bug: a listagem de clientes tinha uma query de "clients"
// separada da ficha do cliente, e essa cópia esqueceu type/notes — o
// ClienteSheet abria com esses campos vazios e, ao gravar (editar pelo
// ícone "..." da lista), apagava o tipo e as notas reais do cliente.
// Confirmado com um cliente descartável injetado e apagado nesta sessão.
// Agora as duas páginas usam esta constante; este teste garante que ela
// nunca perde os campos de que o ClienteSheet depende para não apagar dados.
describe("CLIENTE_SHEET_SELECT — campos obrigatórios para o ClienteSheet", () => {
  const REQUIRED_FIELDS = ["id", "name", "type", "notes", "status", "vat_exempt"];

  it.each(REQUIRED_FIELDS)("inclui o campo '%s'", (field) => {
    expect(CLIENTE_SHEET_SELECT.split(",").map((s) => s.trim())).toContain(field);
  });
});
