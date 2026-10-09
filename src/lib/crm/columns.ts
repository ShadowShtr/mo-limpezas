export const COLUMN_COLORS = ["slate", "blue", "amber", "violet", "green", "red"] as const;
export type ColumnColor = (typeof COLUMN_COLORS)[number];
export interface CrmColumn {
  id: string;
  name: string;
  color: ColumnColor;
}
export function extraColumnKey(id: string): string { return `extra:${id}`; }
export function extraColumnId(key: string): string | null {
  return key.startsWith("extra:") ? key.slice(6) : null;
}
