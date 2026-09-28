const WORD = /[A-Za-z_]/;
const WORD_CONTINUE = /[A-Za-z0-9_$]/;

function lineAt(sql, offset) {
  let line = 1;
  for (let i = 0; i < offset; i += 1) if (sql[i] === "\n") line += 1;
  return line;
}

function skipTrivia(text, from = 0) {
  let i = from;
  while (i < text.length) {
    if (/\s/.test(text[i])) { i += 1; continue; }
    if (text.startsWith("--", i)) {
      const end = text.indexOf("\n", i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (text.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text.startsWith("/*", i)) { depth += 1; i += 2; }
        else if (text.startsWith("*/", i)) { depth -= 1; i += 2; }
        else i += 1;
      }
      continue;
    }
    break;
  }
  return i;
}

function firstWords(text, limit = 3) {
  const words = [];
  let i = 0;
  while (words.length < limit) {
    i = skipTrivia(text, i);
    if (i >= text.length || !WORD.test(text[i])) break;
    const start = i;
    i += 1;
    while (i < text.length && WORD_CONTINUE.test(text[i])) i += 1;
    words.push(text.slice(start, i).toUpperCase());
  }
  return words;
}

function transactionCommand(text) {
  const words = firstWords(text);
  const [first, second] = words;
  if (first === "BEGIN") return "BEGIN";
  if (first === "START" && second === "TRANSACTION") return "START TRANSACTION";
  if (first === "COMMIT" || first === "END") return "COMMIT";
  if (first === "ABORT") return "ROLLBACK";
  if (first === "ROLLBACK") return second === "TO" ? "ROLLBACK TO" : "ROLLBACK";
  if (first === "SAVEPOINT") return "SAVEPOINT";
  if (first === "RELEASE") return "RELEASE SAVEPOINT";
  return null;
}

/**
 * Divide apenas por `;` SQL reais. Delimitadores dentro de strings,
 * identificadores, comentários ou corpos dollar-quoted permanecem no mesmo
 * statement; assim `BEGIN` de PL/pgSQL nunca é confundido com BEGIN de topo.
 */
export function splitTopLevelSqlStatements(sql) {
  const statements = [];
  let start = 0;
  let i = 0;
  let state = "code";
  let blockDepth = 0;
  let dollarTag = "";

  const push = (end) => {
    const text = sql.slice(start, end);
    if (skipTrivia(text) < text.length) statements.push({ text, start, end });
    start = end;
  };

  while (i < sql.length) {
    if (state === "single") {
      if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
      else if (sql[i] === "'") { state = "code"; i += 1; }
      else i += 1;
      continue;
    }
    if (state === "double") {
      if (sql[i] === '"' && sql[i + 1] === '"') i += 2;
      else if (sql[i] === '"') { state = "code"; i += 1; }
      else i += 1;
      continue;
    }
    if (state === "line-comment") {
      if (sql[i] === "\n") state = "code";
      i += 1;
      continue;
    }
    if (state === "block-comment") {
      if (sql.startsWith("/*", i)) { blockDepth += 1; i += 2; }
      else if (sql.startsWith("*/", i)) {
        blockDepth -= 1;
        i += 2;
        if (blockDepth === 0) state = "code";
      } else i += 1;
      continue;
    }
    if (state === "dollar") {
      if (sql.startsWith(dollarTag, i)) {
        i += dollarTag.length;
        state = "code";
      } else i += 1;
      continue;
    }

    if (sql.startsWith("--", i)) { state = "line-comment"; i += 2; continue; }
    if (sql.startsWith("/*", i)) { state = "block-comment"; blockDepth = 1; i += 2; continue; }
    if (sql[i] === "'") { state = "single"; i += 1; continue; }
    if (sql[i] === '"') { state = "double"; i += 1; continue; }
    if (sql[i] === "$") {
      const match = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) { dollarTag = match[0]; state = "dollar"; i += dollarTag.length; continue; }
    }
    if (sql[i] === ";") { push(i + 1); i += 1; continue; }
    i += 1;
  }
  if (state !== "code" && state !== "line-comment") {
    throw new SyntaxError(`SQL termina dentro de ${state}; controlo transacional não pode ser classificado.`);
  }
  push(sql.length);
  return statements;
}

export function analyzeMigrationTransactionControl(sql) {
  const statements = splitTopLevelSqlStatements(sql);
  const controls = statements.flatMap((statement, index) => {
    const command = transactionCommand(statement.text);
    const commandOffset = statement.start + skipTrivia(statement.text);
    return command ? [{ command, statement: index + 1, line: lineAt(sql, commandOffset) }] : [];
  });
  const wrapper = controls.length === 2
    && controls[0].command === "BEGIN"
    && controls[1].command === "COMMIT"
    && controls[0].statement === 1
    && controls[1].statement === statements.length;
  return {
    statementCount: statements.length,
    controls,
    classification: controls.length === 0 ? "runner-owned" : wrapper ? "legacy-outer-wrapper" : "unsupported-control",
  };
}

/**
 * Prepara uma cópia executável sem alterar o ficheiro nem o seu checksum.
 * Apenas o wrapper histórico exterior é removido. Qualquer outro comando de
 * transação de topo é recusado antes de o runner escrever na base.
 */
export function prepareMigrationSql(sql) {
  const analysis = analyzeMigrationTransactionControl(sql);
  if (analysis.classification === "unsupported-control") {
    const detail = analysis.controls
      .map(({ command, line }) => `${command} (linha ${line})`)
      .join(", ");
    throw new Error(`MIGRATION_TRANSACTION_CONTROL_UNSUPPORTED: ${detail || "controlo desconhecido"}`);
  }
  if (analysis.classification === "runner-owned") {
    return { ...analysis, executableSql: sql };
  }
  const statements = splitTopLevelSqlStatements(sql);
  return {
    ...analysis,
    executableSql: sql.slice(statements[0].end, statements.at(-1).start),
  };
}
