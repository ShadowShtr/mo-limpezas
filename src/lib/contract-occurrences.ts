// Wrapper de compatibilidade — sem lógica própria.
//
// Toda a lógica de recorrência (mensal/semanal/quinzenal/3-em-3-semanas/
// diário/personalizado) vive em src/domain/scheduling/recurrence-engine.ts,
// o motor canónico único. Este ficheiro só re-exporta com os nomes que o
// resto do código (createContrato/updateContrato, cron generate-services,
// testes) já importa, para não obrigar a mexer em todos os chamadores de
// uma vez. Nunca voltar a adicionar cálculo de datas aqui — ver AGENTS.md
// regra 8 e docs/atomicidade-audit/recurrence-engine-review.md.
export {
  DOW_TO_KEY,
  shiftToNextBusinessDay,
  occurrencesInRange as getOccurrences,
  type RecurrenceContract as OccurrenceContract,
} from "@/domain/scheduling/recurrence-engine";
