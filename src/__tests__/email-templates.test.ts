import { describe, it, expect } from "vitest";
import { clientReminderTemplate, clientReminderWhatsAppMessage } from "@/lib/email/templates";

const oneService = [{ date: "8 jul", time: "09:00", address: "Rua A, 1", value: 49.24 }];
const twoServices = [
  { date: "8 jul", time: "09:00", address: "Rua A, 1", value: 49.24 },
  { date: "10 jul", time: "10:30", address: "Rua B, 2", value: null },
];

describe("clientReminderTemplate (email)", () => {
  it("assunto no singular para 1 serviço", () => {
    const { subject } = clientReminderTemplate({ clientName: "Ana", services: oneService, companyPhone: "925 780 509" });
    expect(subject).toContain("8 jul às 09:00");
  });

  it("assunto no plural para vários serviços", () => {
    const { subject } = clientReminderTemplate({ clientName: "Ana", services: twoServices, companyPhone: "925 780 509" });
    expect(subject).toBe("Lembrete — 2 serviços agendados | Mó Limpezas");
  });

  it("lista todas as datas/valores no corpo do email", () => {
    const { html } = clientReminderTemplate({ clientName: "Ana", services: twoServices, companyPhone: "925 780 509" });
    expect(html).toContain("8 jul");
    expect(html).toContain("10 jul");
    expect(html).toContain("49,24");
  });

  it("nunca mostra valor quando é null (evita mostrar 0,00€ errado)", () => {
    const { html } = clientReminderTemplate({ clientName: "Ana", services: [{ date: "10 jul", time: "10:30", address: "Rua B", value: null }], companyPhone: "925 780 509" });
    expect(html).not.toContain("💶");
  });

  it("escapa HTML do nome do cliente", () => {
    const { html } = clientReminderTemplate({ clientName: "<script>alert(1)</script>", services: oneService, companyPhone: "925 780 509" });
    expect(html).not.toContain("<script>");
  });
});

describe("clientReminderWhatsAppMessage", () => {
  it("tem emojis", () => {
    const msg = clientReminderWhatsAppMessage({ clientName: "Ana", services: oneService, companyPhone: "925 780 509" });
    expect(msg).toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it("pluraliza a introdução para vários serviços", () => {
    const msg = clientReminderWhatsAppMessage({ clientName: "Ana", services: twoServices, companyPhone: "925 780 509" });
    expect(msg).toContain("próximos serviços");
  });

  it("puxa todas as datas e valores", () => {
    const msg = clientReminderWhatsAppMessage({ clientName: "Ana", services: twoServices, companyPhone: "925 780 509" });
    expect(msg).toContain("8 jul");
    expect(msg).toContain("10 jul");
    expect(msg).toContain("49,24");
  });

  it("omite valor quando null", () => {
    const msg = clientReminderWhatsAppMessage({ clientName: "Ana", services: [{ date: "10 jul", time: "10:30", address: "Rua B", value: null }], companyPhone: "925 780 509" });
    expect(msg).not.toContain("💶");
  });

  it("inclui o telefone da empresa", () => {
    const msg = clientReminderWhatsAppMessage({ clientName: "Ana", services: oneService, companyPhone: "925 780 509" });
    expect(msg).toContain("925 780 509");
  });
});
