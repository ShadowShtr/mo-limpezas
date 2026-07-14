// Importação única dos prédios das 3 "Rotas de Prédios" enviadas pelo dono
// (Equipa 11-Alenquer, Equipa 12-Carregado, Equipa 13-Alverca) para a tabela
// building_cards. Correr uma vez, depois da migration 051 aplicada:
//
//   node scripts/import-predios.mjs           (mostra o que faria)
//   node scripts/import-predios.mjs --apply   (grava mesmo)
//
// Idempotente: salta qualquer (nome, dia da semana) que já exista na tabela,
// por isso é seguro correr mais que uma vez.

import { config } from "dotenv";
config({ path: ".env.local" });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Faltam NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY em .env.local");
  process.exit(1);
}
const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const APPLY = process.argv.includes("--apply");

// IDs reais confirmados em produção (ver conversa) — não inventar/adivinhar.
const TEAM_IDS = {
  alenquer: "0b7e8889-76f4-4aef-9ff4-7150c450a292",  // Equipa 11 - Prédios Alenquer
  carregado: "3b551f25-aa52-4b15-be7f-cc39765c2271", // Equipa 12- Predios Carregado
  alverca: "f349a3df-db96-414c-9af7-4f40fdee8d15",   // Equipa 13 - Predios Alverca
};

// ── Dados transcritos dos 3 PDFs, linha a linha, na ordem em que aparecem ──
// Duplicados entre dias diferentes (ex: "Fagundes 7" à 2ª e à 5ª feira) foram
// mantidos como duas entradas separadas, fiéis ao PDF original.

const ROWS = [
  // ═══ Equipa 13 — Alverca (PDF "10-Alverca") ═══
  { team: "alverca", weekday: "mon", name: "Moçambique 27", address: "Rua de Moçambique n.27 - Sta Iria", notes: "Geral 1x semana" },
  { team: "alverca", weekday: "mon", name: "1º de maio 14", address: "Rua 1 de maio 14, bom sucesso - Alverca", notes: "Geral 1x semana · chave" },
  { team: "alverca", weekday: "mon", name: "Tarré Ribeiro 20", address: "Rua João Tarré Ribeiro, 20 - Alverca", notes: "Geral 1x semana" },
  { team: "alverca", weekday: "mon", name: "Lote 40 (arcena)", address: "Rua João Tarré Ribeiro, 40 - Alverca", notes: "Geral 1x semana · chave não" },
  { team: "alverca", weekday: "mon", name: "Republica 56", address: "Rua da Republica, 56 - Alverca", notes: "Geral 1x semana · 0156E · água" },
  { team: "alverca", weekday: "mon", name: "Rua da industria 1", address: "Rua da Industria 1 - Alverca", notes: "1x sem geral + 1x sem entrada + 1x mês garagem · 134679 · garagens" },
  { team: "alverca", weekday: "mon", name: "Quinta Figueira, Sobralinho", address: "Avenida do Marco da IV Légua, 117 (EN 10 SN) Sobralinho", notes: "Geral 1x semana" },
  { team: "alverca", weekday: "mon", name: "Forças Armadas 12", address: "Rua do Movimento das Forças Armadas 12, Alverca - 2615-317", notes: "Geral 15 em 15 dias" },
  { team: "alverca", weekday: "mon", name: "Palha 14", address: "Rua Julia van Zeller Pereira Palha 14 - Povos", notes: "Geral 1x semana · chave" },
  { team: "alverca", weekday: "mon", name: "Ary dos santos 6", address: "Rua José Carlos Ary dos Santos nº6", notes: "Geral 1x semana · código 19460" },
  { team: "alverca", weekday: "mon", name: "Sebastiao 25", address: "Av Comendador Sebastiao Alves 25 - Vala/Castanheira", notes: "Geral 1x mês · chave" },

  { team: "alverca", weekday: "tue", name: "Lote 20 A - vfx", address: "Rua Manuel Afonso Carvalho, 20A - VFX", notes: "Geral 1x semana · chave" },
  { team: "alverca", weekday: "tue", name: "Bolhão 11", address: "Rua Quinta Bolhão nº11 - VFX", notes: "Geral 1x semana · cartão branco" },
  { team: "alverca", weekday: "tue", name: "Bombarda 273", address: "Rua Dr Miguel Bombarda 273 - VFX", notes: "Geral 1x semana · chave" },
  { team: "alverca", weekday: "tue", name: "Rodrigues 7", address: "Praça Amália Rodrigues 7 (ex lote 25) - VFX", notes: "Geral 15 em 15 dias · chave" },
  { team: "alverca", weekday: "tue", name: "Camões 119A", address: "Rua Luis Camões, 119A - VFX", notes: "Geral 1x semana · chave" },
  { team: "alverca", weekday: "tue", name: "Candido dos reis 85 a 97", address: "Rua Almirante Candido dos Reis 85 a 97 - VFX", notes: "Geral 1x sem + varrer garagem 1x mês + varrer parqueamento/anexo 1x mês · chave" },
  { team: "alverca", weekday: "tue", name: "Pedro Goes 13", address: "Rua Julio José Pedro Goes n13 - VFX", notes: "Geral 1x semana (varrer garagem 3/3 meses) · código 5780" },
  { team: "alverca", weekday: "tue", name: "Moniz 6", address: "Rua de Vasco Moniz nº 6 - Castanheira", notes: "Geral 1x semana" },
  { team: "alverca", weekday: "tue", name: "Moniz 7", address: "Rua de Vasco Moniz nº 7 - Castanheira", notes: "Geral 1x semana · chave" },
  { team: "alverca", weekday: "tue", name: "Carmida Santos Costa, 4", address: "Tv Carmida Santos Costa, 4 - Castanheira", notes: "Geral 1x semana · chave" },

  { team: "alverca", weekday: "wed", name: "Palha 91", address: "Rua Palha Blanco, 91 - Castanheira", notes: "Geral 1x semana · chave ou F2670" },
  { team: "alverca", weekday: "wed", name: "Del Rio 27", address: "Rua António Conceição Dinis nº27", notes: "Geral 1x semana" },
  { team: "alverca", weekday: "wed", name: "Del Rio 2", address: "Rua Hugo Filipe G. Costa e Horta, Nº 2", notes: "Geral 1x semana · código 2846" },
  { team: "alverca", weekday: "wed", name: "Dinis 33", address: "Rua António Conceição Dinis nº33", notes: "Geral 1x semana · chave" },
  { team: "alverca", weekday: "wed", name: "Dinis 4", address: "Rua António Conceição Dinis nº4", notes: "Geral 1x semana · código 1974" },
  { team: "alverca", weekday: "wed", name: "Dinis 2", address: "Rua António Conceição Dinis nº2", notes: "Geral 1x semana · chave" },
  { team: "alverca", weekday: "wed", name: "Correia 9", address: "Rua Joao Batista Correia, 9", notes: "Geral 1x semana · chave" },
  { team: "alverca", weekday: "wed", name: "Correia 11", address: "Rua Joao Batista Correia, 11", notes: "Entrada 15 em 15 dias e geral 15 em 15 · chave" },

  { team: "alverca", weekday: "thu", name: "Cevadeira 20", address: "Praceta da Cevadeira Nascente 20", notes: "Geral 1x semana · chave" },
  { team: "alverca", weekday: "thu", name: "Convento 13", address: "Rua do Convento 13 - Castanheira", notes: "Geral 1x semana (limpeza garagem 15x15) · chave" },
  { team: "alverca", weekday: "thu", name: "Sacadura 8", address: "Rua Sacadura Cabral 8", notes: "Geral 2x mês (15 em 15 dias) · chave" },
  { team: "alverca", weekday: "thu", name: "Edificio imagem", address: "Rua João Batista Correia, nº 42 (Prédio do Minipreço)", notes: "Geral 1x semana · chave" },
  { team: "alverca", weekday: "thu", name: "Varela 7", address: "Av dos Combatentes da Grande Guerra, 7", notes: "Patamares e entrada 1x semana / Geral + passeio da rua 1x mês · chave" },
  { team: "alverca", weekday: "thu", name: "Predio 30 antigo 6", address: "Condominio Rua Joaquim da Silva Ribeiro nº 6 e 6A", notes: "Geral 1x semana · chave" },

  { team: "alverca", weekday: "fri", name: "Naçoes unidas 38", address: "Av das Nações Unidas 38 - Samora", notes: "Geral 1x semana · chave" },
  { team: "alverca", weekday: "fri", name: "Fraternidade 17", address: "Rua da Fraternidade 17 - Benavente", notes: "Geral 15 em 15 dias · chave" },
  { team: "alverca", weekday: "fri", name: "Fraternidade 28", address: "Rua da Fraternidade 28 - Benavente", notes: "Geral 1x semana · chave" },
  { team: "alverca", weekday: "fri", name: "Peres correia 15", address: "Rua D. Paio Peres Correia 15 - Samora", notes: "Geral 1x semana · chave" },
  { team: "alverca", weekday: "fri", name: "Oliveira 14", address: "Rua José Dias Oliveira 14 - Samora", notes: "Geral 1x semana · chave" },
  { team: "alverca", weekday: "fri", name: "Eça de queiros 6", address: "Rua Eça de Queiros 6 - Samora", notes: "Geral 1x semana · chave" },
  { team: "alverca", weekday: "fri", name: "Eça de queiros 8", address: "Rua Eça de Queiros 8 - Samora", notes: "Geral 1x semana · chave" },
  { team: "alverca", weekday: "fri", name: "Herculano 5", address: "Tv Alexandre Herculano 5 - Samora", notes: "Geral 1x semana · chave" },
  { team: "alverca", weekday: "fri", name: "Cortesao 19", address: "Rua Jaime Cortesão 19 - Samora Correia", notes: "Geral 1x semana · chave" },

  // ═══ Equipa 11 — Alenquer ═══
  { team: "alenquer", weekday: "mon", name: "Bravo 23", address: "Urbanização Quinta do Bravo 23", notes: "Geral 15 em 15 dias · chave" },
  { team: "alenquer", weekday: "mon", name: "Bravo 36", address: "Urbanização Quinta do Bravo 36", notes: "Geral 1x semana · chave" },
  { team: "alenquer", weekday: "mon", name: "Bravo 36 A", address: "Urbanização Quinta do Bravo 36A", notes: "Geral 1x semana · chave" },
  { team: "alenquer", weekday: "mon", name: "Carvalho Santos 40", address: "Dr Teofilo Carvalho dos Santos 40 (Bravo 40)", notes: "Geral 1x semana · água: garagem · último piso" },
  { team: "alenquer", weekday: "mon", name: "Bravo 47", address: "Urbanização Quinta do Bravo 47", notes: "Geral 1x semana · chave" },
  { team: "alenquer", weekday: "mon", name: "Lucas 100", address: "Rua Antonio Augusto Nascimento Lucas 100", notes: "Geral 15 em 15 dias · código 3579" },
  { team: "alenquer", weekday: "mon", name: "Lucas 48", address: "Rua Antonio Augusto Nascimento Lucas 48", notes: "Geral 1x semana · chave" },
  { team: "alenquer", weekday: "mon", name: "Pedrogao 14", address: "Rua do Pedrogao 14 - perto da PRIO", notes: "Hall 1x semana / Geral 1x semana · chave" },
  { team: "alenquer", weekday: "mon", name: "Bravo 60", address: "Urbanização Quinta do Bravo 60", notes: "Geral 1x semana · chave" },

  { team: "alenquer", weekday: "tue", name: "Urb. vale dos cavalos, 5", address: "Praceta Acácio Guerra, 9", notes: "Geral 1x semana (garagem lavar 1x/ano, informar antes)" },
  { team: "alenquer", weekday: "tue", name: "Siqueira 3", address: "Praceta Dr Nuno Siqueira 3 - Ota", notes: "Geral 1x semana · chave" },
  { team: "alenquer", weekday: "tue", name: "Goes 3", address: "Urbanização Francisco Goes 3 - Ota", notes: "Geral 1x semana · chave" },
  { team: "alenquer", weekday: "tue", name: "Del Rey", address: "Urbanização Del Rey", notes: "Geral 1x semana · chave" },

  { team: "alenquer", weekday: "wed", name: "Benedito 22", address: "Travessa de São Benedito, 22", notes: "Geral 1x semana (2 blocos) · blocoA:25789 blocoB:08521" },
  { team: "alenquer", weekday: "wed", name: "Gomes Girio 14", address: "Rua Manuel Rodrigues Gomes Girio 14", notes: "Geral 1x semana · 5372 campainha" },
  { team: "alenquer", weekday: "wed", name: "Antonio 22", address: "Rio Residence - Rua Avelino Antonio 22", notes: "Geral 1x semana · chave" },
  { team: "alenquer", weekday: "wed", name: "Chemina 3", address: "Quinta da Chemina 3", notes: "Geral 1x mês · chave · terraço início abril" },
  { team: "alenquer", weekday: "wed", name: "Chemina 15", address: "Quinta da Chemina 15", notes: "Geral 1x semana · código 2734" },
  { team: "alenquer", weekday: "wed", name: "Chemina 13", address: "Quinta da Chemina 13", notes: "Geral 1x semana · chave" },
  { team: "alenquer", weekday: "wed", name: "Cunha 29", address: "Rua Prof. Dr. Pedro da Cunha 29", notes: "Geral 15 em 15 dias · chave" },
  { team: "alenquer", weekday: "wed", name: "Bravo 20", address: "Rua Jorge Cunha e Carmo, 20", notes: "Geral 1x mês · chave" },
  { team: "alenquer", weekday: "wed", name: "Antonio Jalles 48", address: "Av Antonio Maria Jalles 48", notes: "Geral 15 em 15 dias · chave" },
  { team: "alenquer", weekday: "wed", name: "Bravo 20A", address: "Rua Jorge Cunha e Carmo, 20 A", notes: "Geral 1x semana · chave · água R/C · último piso" },

  { team: "alenquer", weekday: "thu", name: "Cortiça 16", address: "Rua Fabrica da Cortiça 16 - Azambuja", notes: "Geral 1x semana · chave" },
  { team: "alenquer", weekday: "thu", name: "Lavanderia 9", address: "Rua da Lavanderia 9 - Azambuja", notes: "Geral 1x semana · chave ou 3579" },
  { team: "alenquer", weekday: "thu", name: "Lavanderia 11", address: "Rua da Lavanderia 11 - Azambuja", notes: "Geral 1x semana · chave ou 3579" },
  { team: "alenquer", weekday: "thu", name: "Forçados amadores 1", address: "Jardim dos Forçados Amadores 1 - Azambuja", notes: "Geral 15 em 15 dias · chave" },
  { team: "alenquer", weekday: "thu", name: "Clemente 4", address: "Rua Jose Clemente 4 - Azambuja", notes: "Entrada 1x semana / Geral 1x mês · chave" },
  { team: "alenquer", weekday: "thu", name: "São Francisco 5", address: "Rua Ordem Terceira de São Francisco 5 - Azambuja", notes: "Geral 1x semana · chave" },
  { team: "alenquer", weekday: "thu", name: "Quinta da arrocacia", address: "Condominio Quinta da Arocacia 42, 43, 44, 45", notes: "Geral 1x semana / garagem 1x ano · chave" },
  { team: "alenquer", weekday: "thu", name: "Pedrogao 14", address: "Rua do Pedrogao 14 - perto da PRIO", notes: "Hall 1x semana / Geral 1x semana · chave" },

  { team: "alenquer", weekday: "fri", name: "Del Rey (entradas)", address: "Urbanização Del Rey", notes: "Entradas · chave" },
  { team: "alenquer", weekday: "fri", name: "Blocos sociais 3", address: "Rua Blocos Sociais 3", notes: "Geral 1x semana · chave" },
  { team: "alenquer", weekday: "fri", name: "Blocos sociais 1", address: "Rua Blocos Sociais 1", notes: "Geral 1x semana · chave" },
  { team: "alenquer", weekday: "fri", name: "Cabral 42", address: "Rua Sacadura Cabral 42", notes: "Geral 1x semana · chave" },
  { team: "alenquer", weekday: "fri", name: "Joaquim falé 38", address: "Rua Joaquim Falé 38", notes: "Geral 1x semana · chave" },
  { team: "alenquer", weekday: "fri", name: "Pinheiros 55", address: "Travessa dos Pinheiros, lote 55", notes: "Geral 1x semana · chave" },
  { team: "alenquer", weekday: "fri", name: "Fontes 67", address: "Rua das Fontes 67", notes: "Geral 1x semanal / 1x mês (sala reuniões, salinha, WC) · chave 1937" },
  { team: "alenquer", weekday: "fri", name: "Cabral 30", address: "Rua Sacadura Cabral 30", notes: "Geral 1x semana · chave" },
  { team: "alenquer", weekday: "fri", name: "Bravo 104", address: "Urbanização Quinta do Bravo 104", notes: "Geral 1x semana · chave" },

  // ═══ Equipa 12 — Carregado ═══
  { team: "carregado", weekday: "mon", name: "Fagundes 7", address: "Praceta João Álvares Fagundes lote 7", notes: "Entrada 2x semana (1x mês geral) · chave · último piso" },
  { team: "carregado", weekday: "mon", name: "Corte Real 55", address: "Praceta Gaspar Corte Real 55", notes: "Entrada 1x semana (1x mês geral) · chave" },
  { team: "carregado", weekday: "mon", name: "Corte Real 60", address: "Praceta Gaspar Corte Real 60", notes: "Entrada 1x semana (1x mês geral) · chave" },
  { team: "carregado", weekday: "mon", name: "Infante 42", address: "Praceta Infante Dom Henrique 42", notes: "Geral 1x semana" },
  { team: "carregado", weekday: "mon", name: "Infante 45", address: "Praceta Infante Dom Henrique 45", notes: "Geral 1x semana · chave" },
  { team: "carregado", weekday: "mon", name: "Infante 45A", address: "Praceta Infante Dom Henrique 45 A", notes: "Geral 1x semana · chave" },
  { team: "carregado", weekday: "mon", name: "Infante 51", address: "Praceta Infante Dom Henrique 51", notes: "Geral 1x semana · 2233 ENTER" },
  { team: "carregado", weekday: "mon", name: "Infante 48", address: "Praceta Infante Dom Henrique 48", notes: "Geral 15 em 15 dias · chave" },
  { team: "carregado", weekday: "mon", name: "Infante 52", address: "Praceta Infante Dom Henrique 52", notes: "Geral 15 em 15 dias · chave" },
  { team: "carregado", weekday: "mon", name: "Gil Eanes 104", address: "Rua Gil Eanes, 104", notes: "Entrada 1x semana / Geral 1x mês · chave" },
  { team: "carregado", weekday: "mon", name: "Gil Eanes 108", address: "Rua Gil Eanes, 108", notes: "Geral 15 em 15 dias · chave" },
  { team: "carregado", weekday: "mon", name: "Gil Eanes 111", address: "Rua Gil Eanes, 111", notes: "Geral 15 em 15 dias · chave" },

  { team: "carregado", weekday: "tue", name: "Teixeira 25", address: "Praceta Tristão Vaz Teixeira, 26", notes: "Entrada 2x semana / Geral 1x mês · chave" },
  { team: "carregado", weekday: "tue", name: "Teixeira 26", address: "Praceta Tristão Vaz Teixeira, 26", notes: "Entrada 1x semana / Geral 1x mês · chave" },
  { team: "carregado", weekday: "tue", name: "Teixeira 27", address: "Praceta Tristão Vaz Teixeira, 27", notes: "Entrada 1x semana / Geral 1x mês · chave" },
  { team: "carregado", weekday: "tue", name: "Teixeira 28", address: "Praceta Tristão Vaz Teixeira, 28", notes: "Entrada 1x semana / Geral 1x mês · chave" },
  { team: "carregado", weekday: "tue", name: "Teixeira 15", address: "Praceta Tristão Vaz Teixeira, 15", notes: "Geral 1x mês e 3x entrada · código 3758" },
  { team: "carregado", weekday: "tue", name: "Teixeira 14", address: "Praceta Tristão Vaz Teixeira, 14", notes: "Geral 1x semana · código 74123" },
  { team: "carregado", weekday: "tue", name: "Cabrilho 81", address: "Praceta João Rodrigues Cabrilho, 81", notes: "Entrada 1x semana / Geral 1x mês · chave" },
  { team: "carregado", weekday: "tue", name: "Cabrilho 78", address: "Praceta João Rodrigues Cabrilho, 78", notes: "Geral 1x semana · código F1951" },
  { team: "carregado", weekday: "tue", name: "Cabrilho 58", address: "Praceta João Rodrigues Cabrilho, 58", notes: "Limpeza semanal (1 Geral / 3x Entrada) · 7845 Enter" },
  { team: "carregado", weekday: "tue", name: "Sequeira 73", address: "Rua Diogo Lopes Sequeira, 73", notes: "Geral 1x semana · chave" },
  { team: "carregado", weekday: "tue", name: "Sequeira 74", address: "Rua Diogo Lopes Sequeira, 74", notes: "Geral 1x semana · chave · último piso" },
  { team: "carregado", weekday: "tue", name: "Sequeira 75", address: "Rua Diogo Lopes Sequeira, 75", notes: "Geral 1x semana · 3257 enter" },
  { team: "carregado", weekday: "tue", name: "Baharem 17", address: "Rua Padre Antonio Baharem, 17", notes: "Geral 1x semana · chave" },

  { team: "carregado", weekday: "wed", name: "Sintra 82", address: "Rua Pedro Sintra 82", notes: "Entrada 1x semana / Geral 1x mês · chave" },
  { team: "carregado", weekday: "wed", name: "Dinis dias 91", address: "Rua Diniz Dias 91", notes: "Geral 1x semana · chave" },
  { team: "carregado", weekday: "wed", name: "Covilha 98", address: "Rua Pero da Covilha 98", notes: "Entrada 1x semana / Geral 1x mês · chave" },
  { team: "carregado", weekday: "wed", name: "Liberdade 5", address: "Rua da Liberdade, 5 - Carregado", notes: "Geral 1x semana" },
  { team: "carregado", weekday: "wed", name: "Liberdade 13", address: "Rua da Liberdade, 13 - Carregado", notes: "Geral 1x semana" },
  { team: "carregado", weekday: "wed", name: "Liberdade 7", address: "Rua da Liberdade, 7 - Carregado", notes: "Geral 1x semana · chave" },
  { team: "carregado", weekday: "wed", name: "Liberdade 4", address: "Rua 5 de Outubro 4 - Carregado", notes: "Geral 1x semana · chave" },
  { team: "carregado", weekday: "wed", name: "Liberdade 1", address: "Rua da Liberdade nº1", notes: "Geral 1x semana · chave" },
  { team: "carregado", weekday: "wed", name: "Fernando Pessoa 2", address: "Rua Fernando Pessoa, 2 - Carregado", notes: "Geral 1x semana" },
  { team: "carregado", weekday: "wed", name: "Florbela 1", address: "Rua Florbela Espanca 1 - Carregado", notes: "Geral 1x semana" },
  { team: "carregado", weekday: "wed", name: "Vaz Monteiro 162", address: "Rua Vaz Monteiro 162 - Carregado", notes: "Geral 1x semana · chave" },
  { team: "carregado", weekday: "wed", name: "Luis de Camões 10", address: "Rua Luís de Camões 10", notes: "Geral 1x semana · código 3579" },

  { team: "carregado", weekday: "thu", name: "Zarco 41", address: "Praceta João Gonçalves Zarco, Lote 41", notes: "Geral (dia 14 de todo mês) · chave" },
  { team: "carregado", weekday: "thu", name: "Zarco 43", address: "Praceta João Gonçalves Zarco 43", notes: "Geral 1x semana" },
  { team: "carregado", weekday: "thu", name: "Zarco 38", address: "Praceta João Gonçalves Zarco, Lote 38", notes: "Geral 1x semana · chave" },
  { team: "carregado", weekday: "thu", name: "Zarco 51", address: "Praceta João Gonçalves Zarco, Lote 51", notes: "Geral 1x semana" },
  { team: "carregado", weekday: "thu", name: "Zarco 52", address: "Praceta João Gonçalves Zarco, Lote 52", notes: "Geral 1x semana" },
  { team: "carregado", weekday: "thu", name: "Zarco 48", address: "Praceta João Gonçalves Zarco, Lote 48", notes: "Geral 15 em 15 dias" },
  { team: "carregado", weekday: "thu", name: "Nuno Tristão 19", address: "Rua Nuno Tristão 19", notes: "Geral 15 em 15 dias · chave" },
  { team: "carregado", weekday: "thu", name: "Diogo Afonso 67", address: "Rua Diogo Afonso 67", notes: "Geral 1x semana · chave" },
  { team: "carregado", weekday: "thu", name: "Diogo Afonso 68", address: "Rua Diogo Afonso 68", notes: "Geral 1x semana · código 45628" },
  { team: "carregado", weekday: "thu", name: "Mendes Pinto 33", address: "Rua Fernão Mendes Pinto 33", notes: "Geral 1x semana · chave" },
  { team: "carregado", weekday: "thu", name: "Mendes pinto 31", address: "Rua Fernão Mendes Pinto, Lote 31", notes: "Geral 2x mês · chave" },
  { team: "carregado", weekday: "thu", name: "Fernão Pó 28", address: "Rua Fernão do Pó, 28", notes: "Geral 1x semana · chave" },
  { team: "carregado", weekday: "thu", name: "Fagundes 8", address: "Praceta João Álvares Fagundes lote 8", notes: "Geral 15 em 15 dias, entrada 1x semana · chave" },
  { team: "carregado", weekday: "thu", name: "Fagundes 7", address: "Praceta João Álvares Fagundes lote 7", notes: "Entrada 2x semana (1x mês geral) · chave · último piso" },

  { team: "carregado", weekday: "fri", name: "Dom Pedro 70A", address: "Rua Dom Pedro 70A", notes: "Geral 1x semana · chave" },
  { team: "carregado", weekday: "fri", name: "Dom Pedro V 45", address: "Rua Dom Pedro V 45", notes: "Geral 15 em 15 dias · chave" },
  { team: "carregado", weekday: "fri", name: "Zarco 32", address: "Praceta João Gonçalves Zarco, Lote 32", notes: "Entrada 1x semana / Geral 1x mês · código 03835" },
  { team: "carregado", weekday: "fri", name: "Corte Real 55", address: "Praceta Gaspar Corte Real 55", notes: "Geral 1x mês, Entrada 2x semana · chave" },
  { team: "carregado", weekday: "fri", name: "Corte Real 61", address: "Praceta Gaspar Corte Real 61", notes: "Entrada 1x semana / Geral 1x mês · chave" },
  { team: "carregado", weekday: "fri", name: "Corte Real 63", address: "Praceta Gaspar Corte Real 63", notes: "Entrada 1x semana / Geral 1x mês · Tag" },
  { team: "carregado", weekday: "fri", name: "Sequeira 75", address: "Rua Diogo Lopes Sequeira, 75", notes: "Entrada 1x semana · 3257 enter" },
  { team: "carregado", weekday: "fri", name: "Alvares Cabral 9", address: "Praceta Pedro Alvares Cabral, 9", notes: "Entrada 1x semana / Geral 1x mês (1ª semana do mês) · chave" },
  { team: "carregado", weekday: "fri", name: "Alvares Cabral 10", address: "Praceta Pedro Alvares Cabral, 10", notes: "Entrada 1x semana / Geral 1x mês (2ª semana do mês) · 87412/74569 chave" },
  { team: "carregado", weekday: "fri", name: "Alvares Cabral 3", address: "Praceta Pedro Alvares Cabral, 3", notes: "Entrada 1x semana / Geral 1x mês (3ª semana do mês) · chave" },
  { team: "carregado", weekday: "fri", name: "Alvares Cabral 2", address: "Praceta Pedro Alvares Cabral, 2", notes: "Entrada 1x semana / Geral 1x mês (4ª semana do mês) · chave" },
];

async function main() {
  console.log(`Modo: ${APPLY ? "APLICAR (grava na base de produção)" : "SIMULAÇÃO (--apply para gravar)"}`);
  console.log(`Total de linhas a processar: ${ROWS.length}`);

  // Confirmar company_id via uma das equipas conhecidas.
  const teamRes = await fetch(
    `${SUPABASE_URL}/rest/v1/teams?id=eq.${TEAM_IDS.alenquer}&select=company_id`,
    { headers: H },
  );
  const teamRows = await teamRes.json();
  const companyId = teamRows?.[0]?.company_id;
  if (!companyId) {
    console.error("Não consegui resolver o company_id a partir da Equipa 11. A abortar.");
    process.exit(1);
  }
  console.log(`company_id: ${companyId}`);

  // Cards já existentes (idempotência por nome+dia da semana).
  const existingRes = await fetch(
    `${SUPABASE_URL}/rest/v1/building_cards?company_id=eq.${companyId}&select=name,weekday,sort_order`,
    { headers: H },
  );
  if (!existingRes.ok) {
    console.error("Erro ao ler building_cards existentes:", await existingRes.text());
    console.error("(A tabela existe? A migration 051 já foi aplicada?)");
    process.exit(1);
  }
  const existing = await existingRes.json();
  const existingKeys = new Set(existing.map((r) => `${r.name}|${r.weekday}`));
  const maxSortByWeekday = {};
  for (const r of existing) {
    maxSortByWeekday[r.weekday] = Math.max(maxSortByWeekday[r.weekday] ?? -1, r.sort_order);
  }

  const toInsert = [];
  let skipped = 0;
  const sortCounters = { ...maxSortByWeekday };
  for (const row of ROWS) {
    const key = `${row.name}|${row.weekday}`;
    if (existingKeys.has(key)) { skipped++; continue; }
    sortCounters[row.weekday] = (sortCounters[row.weekday] ?? -1) + 1;
    toInsert.push({
      company_id: companyId,
      weekday: row.weekday,
      name: row.name,
      address: row.address ?? null,
      team_id: TEAM_IDS[row.team],
      sort_order: sortCounters[row.weekday],
      notes: row.notes ?? null,
    });
  }

  console.log(`A criar: ${toInsert.length} · Já existiam (saltados): ${skipped}`);

  if (!APPLY) {
    console.log("Simulação — nada foi gravado. Corre com --apply para gravar de facto.");
    return;
  }
  if (toInsert.length === 0) {
    console.log("Nada para inserir.");
    return;
  }

  const BATCH = 50;
  let created = 0;
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const batch = toInsert.slice(i, i + BATCH);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/building_cards`, {
      method: "POST",
      headers: { ...H, Prefer: "return=minimal" },
      body: JSON.stringify(batch),
    });
    if (!res.ok) {
      console.error(`Erro no lote ${i}-${i + batch.length}:`, await res.text());
      process.exit(1);
    }
    created += batch.length;
    console.log(`  ${created}/${toInsert.length} gravados...`);
  }

  console.log(`Concluído. ${created} prédios criados.`);
}

main().catch((err) => {
  console.error("Erro inesperado:", err);
  process.exit(1);
});
