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
