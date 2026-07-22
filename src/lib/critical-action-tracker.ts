// Contador partilhado de operações críticas em curso (ex.: clock-in/out).
// A app PWA nunca deve recarregar-se sozinha (para aplicar uma atualização)
// enquanto uma destas operações estiver em curso — foi por isto que o
// service worker ficava à espera de um toque manual em "Atualizar". Este
// contador permite à atualização automática (ver pwa-register.tsx) saber
// quando é seguro recarregar sem arriscar perder um registo de ponto.
let inFlightCount = 0;

export function beginCriticalAction() {
  inFlightCount++;
}

export function endCriticalAction() {
  inFlightCount = Math.max(0, inFlightCount - 1);
}

export function hasCriticalActionInFlight() {
  return inFlightCount > 0;
}
