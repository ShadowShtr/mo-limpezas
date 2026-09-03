export type ClienteSearchItem = { id: string; name: string };

export function normalizeClienteSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-PT");
}

export function filterClientes(
  clientes: ClienteSearchItem[],
  query: string,
): ClienteSearchItem[] {
  const normalizedQuery = normalizeClienteSearch(query).trim();
  if (!normalizedQuery) return clientes;

  return clientes.filter((cliente) =>
    normalizeClienteSearch(cliente.name).includes(normalizedQuery),
  );
}
