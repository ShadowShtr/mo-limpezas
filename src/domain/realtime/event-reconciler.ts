// Reconciliação de eventos Realtime (Task T10).
//
// ── O princípio ─────────────────────────────────────────────────────────────
//
// UM EVENTO REALTIME É UM GATILHO, NÃO UMA FONTE DE VERDADE.
//
// A tentação é pegar no `payload.new` e fundi-lo no estado local. Isso cria um
// objeto que o servidor nunca produziu: o payload traz as colunas da tabela,
// não o que a página realmente lê (juntas, vistas, valores calculados,
// permissões). O resultado é um cartão no calendário com metade dos dados
// certos e metade inventados.
//
// A regra aqui é outra: o evento decide apenas SE vale a pena voltar a
// perguntar ao servidor. O estado vem sempre da resposta autoritativa.
//
// ── O que este módulo resolve ───────────────────────────────────────────────
//
// 1. EVENTOS FORA DE ORDEM. A rede não garante ordem. Receber UPDATE A depois
//    de UPDATE B faria o ecrã voltar atrás no tempo.
// 2. EVENTOS DUPLICADOS. Reconexões e múltiplos handlers entregam o mesmo
//    evento mais do que uma vez; um refetch por cada é desperdício, e uma
//    fusão manual duplicaria cartões.
// 3. EVENTOS DE OUTRA EMPRESA. Metade das subscrições atuais não declara
//    filtro e depende inteiramente da RLS. Isto é a segunda linha de defesa.
// 4. DELETE COM PAYLOAD INCOMPLETO. O `old` de um DELETE traz muitas vezes só
//    a chave primária — não dá para decidir nada a partir dele.
//
// Módulo PURO: sem Supabase, sem rede, sem relógio, sem estado global.

/** Tipos de evento que o `postgres_changes` entrega. */
export type RealtimeEventType = "INSERT" | "UPDATE" | "DELETE";

export interface RealtimeEvent {
  table: string;
  type: RealtimeEventType;
  /** Linha após a mudança. Ausente no DELETE. */
  new?: Record<string, unknown> | null;
  /** Linha antes da mudança. No DELETE traz frequentemente só a chave. */
  old?: Record<string, unknown> | null;
}

export type EventDecision =
  /** Gatilho válido — ir buscar o snapshot autoritativo. */
  | "REFETCH"
  /** Evento de outra empresa. */
  | "IGNORE_FOREIGN_TENANT"
  /** Já processado. */
  | "IGNORE_DUPLICATE"
  /** Mais antigo do que o que já foi visto para esta linha. */
  | "IGNORE_STALE"
  /** Tabela que este consumidor não observa. */
  | "IGNORE_UNKNOWN_TABLE";

export interface EventVerdict {
  decision: EventDecision;
  reason: string;
}

/** O consumidor age sobre este veredicto? */
export function shouldRefetch(verdict: EventVerdict): boolean {
  return verdict.decision === "REFETCH";
}

// ─── leitura defensiva do payload ───────────────────────────────────────────

function readString(row: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = row?.[key];
  return typeof value === "string" ? value : null;
}

/** Linha relevante do evento: `new` no INSERT/UPDATE, `old` no DELETE. */
export function eventRow(event: RealtimeEvent): Record<string, unknown> | null {
  return (event.type === "DELETE" ? event.old : event.new) ?? null;
}

/** Identificador da linha, quando o payload o traz. */
export function eventRowId(event: RealtimeEvent): string | null {
  return readString(eventRow(event), "id");
}

/** Empresa da linha, quando o payload a traz. */
export function eventCompanyId(event: RealtimeEvent): string | null {
  return readString(eventRow(event), "company_id");
}

/**
 * Marca temporal da linha. `updated_at` já existe em todas as tabelas de
 * negócio (trigger `update_updated_at`), por isso serve de relógio de versão
 * sem acrescentar coluna nenhuma.
 */
export function eventVersion(event: RealtimeEvent): string | null {
  const row = eventRow(event);
  return readString(row, "updated_at") ?? readString(row, "created_at");
}

// ─── memória do que já foi visto ────────────────────────────────────────────

/**
 * Registo do que já passou por aqui.
 *
 * Deliberadamente simples e limitado: guarda a última versão vista por linha e
 * as chaves de evento já processadas, com um teto para não crescer sem fim
 * numa sessão longa.
 */
export class EventLedger {
  private readonly lastVersion = new Map<string, string>();
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly maxEntries = 500) {}

  private static rowKey(event: RealtimeEvent): string | null {
    const id = eventRowId(event);
    return id === null ? null : `${event.table}|${id}`;
  }

  private static eventKey(event: RealtimeEvent): string | null {
    const rowKey = EventLedger.rowKey(event);
    if (rowKey === null) return null;
    return `${rowKey}|${event.type}|${eventVersion(event) ?? ""}`;
  }

  /** Já foi processado exatamente este evento? */
  isDuplicate(event: RealtimeEvent): boolean {
    const key = EventLedger.eventKey(event);
    return key !== null && this.seen.has(key);
  }

  /**
   * O evento é mais antigo do que o último visto para a mesma linha?
   *
   * Comparação lexicográfica de timestamps ISO — que é cronológica desde que
   * venham no mesmo formato, como vêm do PostgreSQL.
   */
  isStale(event: RealtimeEvent): boolean {
    const rowKey = EventLedger.rowKey(event);
    const version = eventVersion(event);
    if (rowKey === null || version === null) return false;
    const previous = this.lastVersion.get(rowKey);
    return previous !== undefined && version < previous;
  }

  /** Regista o evento como processado. */
  remember(event: RealtimeEvent): void {
    const rowKey = EventLedger.rowKey(event);
    const eventKey = EventLedger.eventKey(event);
    if (rowKey === null || eventKey === null) return;

    const version = eventVersion(event);
    if (version !== null) {
      const previous = this.lastVersion.get(rowKey);
      if (previous === undefined || version > previous) {
        this.lastVersion.set(rowKey, version);
      }
    }

    if (!this.seen.has(eventKey)) {
      this.seen.add(eventKey);
      this.order.push(eventKey);
      while (this.order.length > this.maxEntries) {
        const oldest = this.order.shift();
        if (oldest !== undefined) this.seen.delete(oldest);
      }
    }
  }

  /**
   * Esquece tudo. Obrigatório ao reconectar: durante a desconexão houve
   * escritas que nunca chegaram, por isso o que está em memória deixa de
   * poder servir para decidir o que é antigo.
   */
  reset(): void {
    this.lastVersion.clear();
    this.seen.clear();
    this.order.length = 0;
  }

  get size(): number {
    return this.seen.size;
  }
}

// ─── decisão ────────────────────────────────────────────────────────────────

export interface DecideEventInput {
  event: RealtimeEvent;
  /** Empresa da sessão. Eventos de outra empresa são descartados. */
  companyId: string;
  /** Tabelas que este consumidor observa. */
  watchedTables: readonly string[];
  ledger?: EventLedger;
}

/**
 * Decide o que fazer com um evento.
 *
 * A ordem das verificações é a política:
 *
 *   1. tabela não observada — nem vale a pena olhar;
 *   2. empresa errada — segunda linha de defesa a seguir à RLS;
 *   3. duplicado;
 *   4. mais antigo do que o que já se viu;
 *   5. caso contrário, ir buscar o estado autoritativo.
 *
 * Note-se o que NÃO está aqui: em nenhum caso o payload é usado para
 * construir estado. Só para decidir se se pergunta ao servidor.
 */
export function decideEvent(input: DecideEventInput): EventVerdict {
  const { event, companyId, watchedTables, ledger } = input;

  if (!watchedTables.includes(event.table)) {
    return {
      decision: "IGNORE_UNKNOWN_TABLE",
      reason: `${event.table} não é observada por este consumidor`,
    };
  }

  const eventCompany = eventCompanyId(event);
  if (eventCompany !== null && eventCompany !== companyId) {
    return {
      decision: "IGNORE_FOREIGN_TENANT",
      reason: "evento de outra empresa",
    };
  }

  // Um DELETE traz muitas vezes só a chave primária: sem `updated_at` não há
  // como avaliar antiguidade, e sem `company_id` não há como avaliar empresa.
  // Nesse caso vale sempre a pena voltar a perguntar — a consulta é feita no
  // servidor e já está limitada à empresa da sessão.
  if (event.type === "DELETE") {
    if (ledger?.isDuplicate(event)) {
      return { decision: "IGNORE_DUPLICATE", reason: "DELETE já processado" };
    }
    return {
      decision: "REFETCH",
      reason: "DELETE — payload incompleto por natureza, refetch obrigatório",
    };
  }

  if (ledger?.isDuplicate(event)) {
    return { decision: "IGNORE_DUPLICATE", reason: "evento já processado" };
  }

  if (ledger?.isStale(event)) {
    return {
      decision: "IGNORE_STALE",
      reason: "chegou fora de ordem, mais antigo do que o já conhecido",
    };
  }

  return { decision: "REFETCH", reason: "mudança relevante — buscar snapshot autoritativo" };
}

/**
 * Decide e regista de uma vez. É o que um handler deve chamar.
 *
 * Regista mesmo quando ignora por antiguidade: o evento passou por aqui e não
 * deve voltar a ser avaliado.
 */
export function processEvent(input: DecideEventInput): EventVerdict {
  const verdict = decideEvent(input);
  if (verdict.decision !== "IGNORE_UNKNOWN_TABLE"
    && verdict.decision !== "IGNORE_FOREIGN_TENANT") {
    input.ledger?.remember(input.event);
  }
  return verdict;
}
