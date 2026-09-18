// ============================================================================
// Ciclo de vida de um colaborador — a forma das coisas
// ============================================================================
//
// Separado de `lifecycle.ts` porque o ficheiro gerado
// (`profile-fk-inventory.ts`) importa daqui, e um gerado que importasse do
// módulo de decisão criaria um ciclo entre os dois.
// ============================================================================

/** Uma coluna que aponta para `public.profiles(id)`. Lida do catálogo. */
export interface ReferenciaPerfil {
  /** Tabela em `public` que guarda a referência. */
  tabela: string;
  /** Coluna emparelhada com `profiles.id` — a que nomeia a pessoa. */
  coluna: string;
  /** Nome da restrição no catálogo, para o ensaio poder comparar. */
  restricao: string;
  /** `CASCADE`, `SET NULL`, `SET DEFAULT`, `RESTRICT` ou `NO ACTION`. */
  onDelete: string;
  /**
   * FK composta `(coluna, company_id)` → `(id, company_id)`.
   *
   * Importa porque a outra metade é a barreira de empresa: quem tratasse isto
   * como uma FK simples podia anular `company_id` e partir o isolamento.
   */
  composta: boolean;
  /** Área de negócio, para a interface poder explicar-se a quem lê. */
  area: string;
}

/**
 * O que a sondagem encontrou numa referência.
 *
 * `erro` não é o mesmo que `contagem: 0`, e a diferença é a razão de ser deste
 * tipo. Uma sondagem que falhou não diz que não há histórico — diz que não se
 * sabe. Achatar as duas em zero seria transformar ignorância em autorização.
 */
export type SondagemRelacao =
  | { ref: ReferenciaPerfil; estado: "lida"; contagem: number }
  | { ref: ReferenciaPerfil; estado: "falhada"; detalhe: string };

/** Uma área com histórico, já agregada para ser mostrada a quem lê. */
export interface RelacaoEncontrada {
  area: string;
  tabela: string;
  coluna: string;
  contagem: number;
}

/**
 * O veredito sobre a eliminação física de um perfil.
 *
 * `elegivel: true` só sai quando TODAS as referências do inventário foram
 * sondadas com sucesso e TODAS vieram a zero. Qualquer outra combinação —
 * uma relação encontrada, uma sondagem falhada, uma referência por sondar —
 * devolve `false`. É o `UNKNOWN_STATE = FAIL_CLOSED` escrito em código.
 */
export interface VeredictoRemocao {
  elegivel: boolean;
  /** Código estável, para a interface ramificar sem comparar texto. */
  codigo:
    | "SEM_HISTORICO"
    | "TEM_HISTORICO"
    | "SONDAGEM_INCOMPLETA"
    | "SONDAGEM_FALHADA";
  /** Áreas com histórico, ordenadas por volume. Vazio quando elegível. */
  relacoes: RelacaoEncontrada[];
  /** Referências que não se conseguiu ler. Vazio quando elegível. */
  falhas: { tabela: string; coluna: string; detalhe: string }[];
  /** Total de linhas com autoria desta pessoa, somando todas as áreas. */
  totalRegistos: number;
}
