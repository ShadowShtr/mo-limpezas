import { describe, it, expect, vi, afterEach } from "vitest";
import { formatDistanceToNow, formatTime, formatDate, cn, safeFormat, isValidIsoDateString } from "@/lib/utils";

afterEach(() => {
  vi.useRealTimers();
});

// ─── cn (class merge utility) ────────────────────────────────────────────────

describe("cn", () => {
  it("merges two class strings", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("deduplicates conflicting Tailwind classes (last wins)", () => {
    // tailwind-merge: p-2 and p-4 → last one wins
    const result = cn("p-2", "p-4");
    expect(result).toBe("p-4");
  });

  it("filters falsy values", () => {
    expect(cn("foo", false && "bar", undefined, null as unknown as string, "baz")).toBe("foo baz");
  });

  it("handles conditional object syntax", () => {
    const result = cn({ active: true, disabled: false });
    expect(result).toBe("active");
  });

  it("handles array syntax", () => {
    const result = cn(["foo", "bar"]);
    expect(result).toBe("foo bar");
  });

  it("empty input returns empty string", () => {
    expect(cn()).toBe("");
  });
});

// ─── formatDistanceToNow ─────────────────────────────────────────────────────

describe("formatDistanceToNow", () => {
  function dateAgo(ms: number): string {
    return new Date(Date.now() - ms).toISOString();
  }

  it("< 1 minute ago → 'agora mesmo'", () => {
    expect(formatDistanceToNow(dateAgo(30_000))).toBe("agora mesmo");
  });

  it("1 minute ago → 'há 1 min'", () => {
    expect(formatDistanceToNow(dateAgo(60_000))).toBe("há 1 min");
  });

  it("45 minutes ago → 'há 45 min'", () => {
    expect(formatDistanceToNow(dateAgo(45 * 60_000))).toBe("há 45 min");
  });

  it("59 minutes ago → 'há 59 min'", () => {
    expect(formatDistanceToNow(dateAgo(59 * 60_000))).toBe("há 59 min");
  });

  it("1 hour ago → 'há 1h'", () => {
    expect(formatDistanceToNow(dateAgo(60 * 60_000))).toBe("há 1h");
  });

  it("7 hours ago → 'há 7h'", () => {
    expect(formatDistanceToNow(dateAgo(7 * 60 * 60_000))).toBe("há 7h");
  });

  it("23 hours ago → 'há 23h'", () => {
    expect(formatDistanceToNow(dateAgo(23 * 60 * 60_000))).toBe("há 23h");
  });

  it("1 day ago → 'há 1 dia'", () => {
    expect(formatDistanceToNow(dateAgo(24 * 60 * 60_000))).toBe("há 1 dia");
  });

  it("3 days ago → 'há 3 dias'", () => {
    expect(formatDistanceToNow(dateAgo(3 * 24 * 60 * 60_000))).toBe("há 3 dias");
  });

  it("6 days ago → 'há 6 dias'", () => {
    expect(formatDistanceToNow(dateAgo(6 * 24 * 60 * 60_000))).toBe("há 6 dias");
  });

  it("> 7 days → locale date string (not a relative phrase)", () => {
    const result = formatDistanceToNow(dateAgo(8 * 24 * 60 * 60_000));
    // Should not be a "há X" phrase
    expect(result).not.toMatch(/^há/);
    // Should be a date string (dd mmm in pt-PT)
    expect(result.length).toBeGreaterThan(0);
  });
});

// ─── formatTime ──────────────────────────────────────────────────────────────

describe("formatTime", () => {
  it("midnight UTC → '00:00'", () => {
    expect(formatTime("2024-01-15T00:00:00Z")).toMatch(/00:00/);
  });

  it("noon UTC → '12:00'", () => {
    expect(formatTime("2024-01-15T12:00:00Z")).toMatch(/12:00/);
  });

  it("returns HH:MM format (2 digits each)", () => {
    const result = formatTime("2024-01-15T08:05:00Z");
    expect(result).toMatch(/^\d{2}:\d{2}$/);
  });

  it("same date gives same result on repeated calls", () => {
    const d = "2024-06-15T14:30:00Z";
    expect(formatTime(d)).toBe(formatTime(d));
  });
});

// ─── formatDate ──────────────────────────────────────────────────────────────

describe("formatDate", () => {
  it("returns a non-empty string", () => {
    expect(formatDate("2024-01-15")).toBeTruthy();
  });

  it("includes the day number", () => {
    const result = formatDate("2024-01-15T00:00:00Z");
    expect(result).toMatch(/15/);
  });

  it("same date gives same result on repeated calls (deterministic)", () => {
    const d = "2024-06-15T00:00:00Z";
    expect(formatDate(d)).toBe(formatDate(d));
  });
});

// ─── safeFormat (regressão: crash "Esta secção não carregou" no cliente Paulo
// Parreira, causado por date-fns format() a lançar RangeError com uma
// Invalid Date vinda de um contract.starts_on corrompido) ────────────────────

describe("safeFormat", () => {
  it("formata uma data válida normalmente", () => {
    expect(safeFormat("2026-07-10T00:00:00Z", "yyyy-MM-dd")).toBe("2026-07-10");
  });

  it("devolve o fallback para uma string de data inválida, sem lançar", () => {
    expect(() => safeFormat("72026-01-01", "d MMM yyyy")).not.toThrow();
    expect(safeFormat("72026-01-01", "d MMM yyyy")).toBe("—");
  });

  it("devolve o fallback para null/undefined/vazio", () => {
    expect(safeFormat(null, "yyyy-MM-dd")).toBe("—");
    expect(safeFormat(undefined, "yyyy-MM-dd")).toBe("—");
    expect(safeFormat("", "yyyy-MM-dd")).toBe("—");
  });

  it("aceita um fallback customizado", () => {
    expect(safeFormat("lixo", "yyyy-MM-dd", undefined, "sem data")).toBe("sem data");
  });

  it("aceita um objeto Date diretamente", () => {
    expect(safeFormat(new Date("2026-01-01T00:00:00Z"), "yyyy-MM-dd")).toBe("2026-01-01");
  });

  it("devolve o fallback para um objeto Date inválido", () => {
    expect(safeFormat(new Date("not a date"), "yyyy-MM-dd")).toBe("—");
  });
});

// ─── isValidIsoDateString (bloqueia a gravação de starts_on/ends_on
// corrompidos em createContrato/updateContrato) ───────────────────────────────

describe("isValidIsoDateString", () => {
  it("aceita uma data YYYY-MM-DD normal", () => {
    expect(isValidIsoDateString("2026-07-10")).toBe(true);
  });

  it("rejeita um ano com dígitos a mais (o bug real: 72026-01-01)", () => {
    expect(isValidIsoDateString("72026-01-01")).toBe(false);
  });

  it("rejeita mês/dia inexistentes (round-trip falha)", () => {
    expect(isValidIsoDateString("2026-02-30")).toBe(false);
    expect(isValidIsoDateString("2026-13-01")).toBe(false);
  });

  it("rejeita formatos que não sejam YYYY-MM-DD", () => {
    expect(isValidIsoDateString("10/07/2026")).toBe(false);
    expect(isValidIsoDateString("2026-7-10")).toBe(false);
    expect(isValidIsoDateString("")).toBe(false);
  });

  it("rejeita anos fora do intervalo plausível por omissão", () => {
    expect(isValidIsoDateString("1899-01-01")).toBe(false);
    expect(isValidIsoDateString("2101-01-01")).toBe(false);
  });

  it("respeita minYear/maxYear customizados", () => {
    expect(isValidIsoDateString("1950-01-01", { minYear: 1900, maxYear: 2100 })).toBe(true);
  });
});
