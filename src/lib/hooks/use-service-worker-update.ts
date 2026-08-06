"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createOnceGuard,
  getLastAcceptedVersion,
  setLastAcceptedVersion,
  shouldShowUpdatePrompt,
} from "@/lib/sw-update";

// Registo + deteção de atualização do service worker, partilhado entre
// pwa-register.tsx (app das colaboradoras) e sw-update-prompt.tsx
// (dashboard). A decisão de "mostrar ou não o aviso" vive em
// src/lib/sw-update.ts (pura, testada); aqui só fica a parte que precisa de
// DOM/service worker real (por isso este ficheiro não tem teste dedicado —
// vitest.config.ts corre em ambiente "node", sem DOM; ver o mesmo padrão em
// src/lib/hooks/use-single-flight.ts).
//
// Contrato exigido (bug de produção corrigido nesta sessão):
//   - a versão em espera é perguntada DIRETAMENTE ao service worker exato
//     (via MessageChannel), nunca assumida — só assim dá para comparar com
//     a última versão aceite e decidir corretamente se mostra o aviso;
//   - clicar "Atualizar" esconde o aviso já, marca a versão como aceite
//     ANTES de pedir a ativação (mesmo que o browser feche a meio, a marca
//     já ficou gravada) e ativa exatamente o ServiceWorker capturado — nunca
//     um `reg.waiting` relido no momento do clique, que podia já ter mudado;
//   - o reload acontece exatamente uma vez, por um `createOnceGuard`
//     partilhado entre o evento `controllerchange` e o fallback de 3s;
//   - se chegar um evento de atualização mais recente enquanto uma consulta
//     de versão anterior ainda está no ar, a resposta antiga é descartada
//     (token de pedido) — nunca deixa a versão andar "para trás".
const GET_VERSION_TIMEOUT_MS = 2000;

function queryWorkerVersion(sw: ServiceWorker): Promise<string | null> {
  return new Promise((resolve) => {
    if (typeof MessageChannel === "undefined") {
      resolve(null);
      return;
    }
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), GET_VERSION_TIMEOUT_MS);
    channel.port1.onmessage = (event: MessageEvent) => {
      clearTimeout(timer);
      resolve(event.data?.version ?? null);
    };
    try {
      sw.postMessage({ type: "GET_VERSION" }, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

export interface UseServiceWorkerUpdateOptions {
  /** Aplica a atualização sozinho quando a app for para segundo plano (só a app das colaboradoras usa isto). */
  autoApplyInBackground?: boolean;
  /** Chamado antes de aplicar automaticamente em segundo plano — se devolver false, adia. */
  isSafeToAutoApply?: () => boolean;
  /** Chamado uma vez com o registration, depois do register() resolver (ex.: para subscrever push). */
  onRegistered?: (registration: ServiceWorkerRegistration) => void;
}

export function useServiceWorkerUpdate(options: UseServiceWorkerUpdateOptions = {}) {
  const { autoApplyInBackground = false, isSafeToAutoApply, onRegistered } = options;

  const [waitingSw, setWaitingSw] = useState<ServiceWorker | null>(null);
  const [reloading, setReloading] = useState(false);

  const reloadGuardRef = useRef(createOnceGuard());
  const requestTokenRef = useRef(0);
  const capturedSwRef = useRef<ServiceWorker | null>(null);
  const capturedVersionRef = useRef<string | null>(null);

  const reloadOnce = useCallback(() => {
    reloadGuardRef.current.run(() => window.location.reload());
  }, []);

  // Refs para as opções — evita reinscrever o efeito principal (que só deve
  // correr uma vez) sempre que um callback inline muda de identidade.
  // Atualizadas num efeito (nunca durante o render) para não violar a regra
  // "no ref mutation during render" do react-hooks.
  const autoApplyRef = useRef(autoApplyInBackground);
  const isSafeRef = useRef(isSafeToAutoApply);
  const onRegisteredRef = useRef(onRegistered);
  useEffect(() => {
    autoApplyRef.current = autoApplyInBackground;
    isSafeRef.current = isSafeToAutoApply;
    onRegisteredRef.current = onRegistered;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    const hadController = !!navigator.serviceWorker.controller;
    let userTriggered = false;

    function onControllerChange() {
      if (hadController && userTriggered) reloadOnce();
    }
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    let cleanupVisibility: (() => void) | undefined;

    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((reg) => {
        async function evaluate(sw: ServiceWorker | null) {
          if (!sw || !reg.active) return;
          const token = ++requestTokenRef.current;
          const version = await queryWorkerVersion(sw);
          if (token !== requestTokenRef.current) return; // resposta ultrapassada por um evento mais recente

          const lastAccepted = getLastAcceptedVersion(window.localStorage);
          if (!shouldShowUpdatePrompt(version, lastAccepted)) {
            capturedSwRef.current = null;
            capturedVersionRef.current = null;
            setWaitingSw(null);
            return;
          }

          capturedSwRef.current = sw;
          capturedVersionRef.current = version ?? null;
          setWaitingSw(sw);
        }

        // Já existe uma versão à espera (atualização pendente de sessão anterior).
        evaluate(reg.waiting);

        // Nova versão encontrada → quando ficar "installed", há atualização.
        reg.addEventListener("updatefound", () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (installing.state === "installed") evaluate(reg.waiting);
          });
        });

        function activate() {
          userTriggered = true;
          const sw = capturedSwRef.current;
          const version = capturedVersionRef.current;
          // Marca como aceite ANTES de pedir a ativação — mesmo que o
          // reload nunca chegue a acontecer (browser fechado a meio), a
          // versão já fica registada como tratada, e o aviso não volta.
          if (version) setLastAcceptedVersion(window.localStorage, version);
          setWaitingSw(null);
          sw?.postMessage("SKIP_WAITING");
        }

        // Expor o gatilho de ativação para o botão "Atualizar".
        (window as unknown as { __activateUpdate?: () => void }).__activateUpdate = activate;

        const onVisible = () => {
          if (document.visibilityState === "visible") {
            reg.update().catch(() => {});
          } else if (autoApplyRef.current && reg.waiting && (!isSafeRef.current || isSafeRef.current())) {
            activate();
          }
        };
        document.addEventListener("visibilitychange", onVisible);
        cleanupVisibility = () => document.removeEventListener("visibilitychange", onVisible);

        // Push de controlo "força atualização": pede uma verificação e, se
        // for seguro, aplica de imediato em vez de esperar pelo próximo
        // ciclo de segundo plano.
        navigator.serviceWorker.addEventListener("message", (event) => {
          if (event.data?.type === "CHECK_FOR_UPDATE") {
            reg.update().catch(() => {});
            if (reg.waiting && autoApplyRef.current && (!isSafeRef.current || isSafeRef.current())) {
              activate();
            }
          }
        });

        onRegisteredRef.current?.(reg);
      })
      .catch(() => {});

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      cleanupVisibility?.();
    };
  }, [reloadOnce]);

  const apply = useCallback(() => {
    setReloading(true);
    const activate = (window as unknown as { __activateUpdate?: () => void }).__activateUpdate;
    if (activate) {
      activate();
      // Fallback: se o controllerchange não disparar em 3s, recarregar à mão.
      // Partilha o mesmo createOnceGuard — nunca recarrega duas vezes.
      setTimeout(reloadOnce, 3000);
    } else {
      reloadOnce();
    }
  }, [reloadOnce]);

  return { waiting: waitingSw, reloading, apply };
}
