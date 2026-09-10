import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // `.tsx` entrou a 2026-08-19: o defeito de hidratação dos anexos só se
    // prova montando o componente a sério. Um teste que lesse o ficheiro à
    // procura de `useState(prop)` não distinguiria o bug de uma sincronização
    // correcta — e foi precisamente por não haver teste de comportamento que
    // ele passou despercebido.
    include: ["src/__tests__/**/*.test.ts", "src/__tests__/**/*.test.tsx"],
    testTimeout: 15_000,
    // ─────────────────────────────────────────────────────────────────────
    // `hookTimeout` separado do `testTimeout` de propósito.
    //
    // Onze ficheiros de ensaio arrancam um PostgreSQL em Docker e reconstroem
    // o schema inteiro num `beforeEach`. Cada `it` desses ficheiros já declara
    // 120s à mão, mas os hooks ficaram com os 10s por omissão do vitest — e,
    // com a suite completa a correr em paralelo, um desses hooks estourava por
    // carga da máquina, não por defeito nenhum. Falha intermitente num hook é
    // pior do que uma falha franca: manda procurar o bug no sítio errado.
    //
    // (Sem nomear aqui ficheiro nenhum, de propósito: o inventário de
    // ficheiros procura nomes de módulos dentro dos ficheiros de
    // configuração, e uma simples menção em comentário marcava módulos de
    // produção como tendo uma porta de configuração/CLI que não têm.)
    //
    // Isto NÃO afrouxa nenhuma prova — `testTimeout` continua nos 15s, e o
    // limite de um hook só decide quanto tempo se espera pelo arranque, nunca
    // o que é verificado. Um hook verdadeiramente pendurado continua a falhar,
    // apenas mais tarde.
    // ─────────────────────────────────────────────────────────────────────
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
      exclude: ["src/lib/supabase/**", "src/lib/email/**", "src/lib/auth/**"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
