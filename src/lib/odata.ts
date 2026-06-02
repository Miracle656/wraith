export type ODataFieldType = "string" | "number" | "date";

type FieldDefinition = {
  type: ODataFieldType;
};

type ComparisonOperator = "eq" | "gt" | "lt";

type ParsedClause =
  | { kind: "comparison"; field: string; operator: ComparisonOperator; value: unknown }
  | { kind: "contains"; field: string; value: string };

function splitAndClauses(filter: string): string[] {
  const clauses: string[] = [];
  let current = "";
  let depth = 0;
  let inString = false;

  for (let index = 0; index < filter.length; index++) {
    const char = filter[index];
    const next = filter[index + 1];

    if (char === "'") {
      current += char;
      if (inString && next === "'") {
        current += next;
        index++;
        continue;
      }
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === "(") depth++;
      if (char === ")") depth = Math.max(0, depth - 1);

      if (depth === 0 && filter.slice(index, index + 4).toLowerCase() === " and") {
        clauses.push(current.trim());
        current = "";
        index += 3;
        continue;
      }
    }

    current += char;
  }

  if (current.trim()) clauses.push(current.trim());
  return clauses;
}

function parseStringLiteral(raw: string): string {
  if (!raw.startsWith("'") || !raw.endsWith("'")) {
    throw new Error("String values must be wrapped in single quotes.");
  }

  return raw.slice(1, -1).replace(/''/g, "'");
}

function parseClause(rawClause: string): ParsedClause {
  const containsMatch = rawClause.match(/^contains\(\s*([A-Za-z_][A-Za-z0-9_\.]*)\s*,\s*('(?:''|[^'])*')\s*\)$/i);
  if (containsMatch) {
    return {
      kind: "contains",
      field: containsMatch[1],
      value: parseStringLiteral(containsMatch[2]),
    };
  }

  const comparisonMatch = rawClause.match(/^([A-Za-z_][A-Za-z0-9_\.]*)\s+(eq|gt|lt)\s+(.+)$/i);
  if (!comparisonMatch) {
    throw new Error(`Unsupported $filter clause: ${rawClause}`);
  }

  const [, field, operator, rawValue] = comparisonMatch;
  return {
    kind: "comparison",
    field,
    operator: operator.toLowerCase() as ComparisonOperator,
    value: rawValue.trim(),
  };
}

function parseComparisonValue(field: string, rawValue: unknown, definition: FieldDefinition): unknown {
  if (definition.type === "string") {
    if (typeof rawValue !== "string") throw new Error(`Invalid value for ${field}.`);
    return parseStringLiteral(rawValue.trim());
  }

  if (definition.type === "number") {
    const normalized = String(rawValue).trim();
    if (/^-?\d+$/.test(normalized)) return Number(normalized);
    if (normalized.startsWith("'") && normalized.endsWith("'")) {
      const unquoted = parseStringLiteral(normalized);
      if (/^-?\d+$/.test(unquoted)) return Number(unquoted);
    }
    throw new Error(`Invalid numeric value for ${field}.`);
  }

  const normalized = String(rawValue).trim();
  const candidate = normalized.startsWith("'") && normalized.endsWith("'")
    ? parseStringLiteral(normalized)
    : normalized;
  const date = new Date(candidate);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date value for ${field}.`);
  }
  return date;
}

export function parseODataFilter(
  filter: string | undefined,
  fields: Record<string, FieldDefinition>
): Record<string, unknown> | undefined {
  const normalized = filter?.trim();
  if (!normalized) return undefined;

  if (/\bor\b/i.test(normalized)) {
    throw new Error("$filter only supports AND combinations.");
  }

  const clauses = splitAndClauses(normalized);
  if (clauses.length === 0) return undefined;

  const filters = clauses.map((clause) => {
    const parsed = parseClause(clause);
    const definition = fields[parsed.field];
    if (!definition) {
      throw new Error(`Unsupported $filter field: ${parsed.field}`);
    }

    if (parsed.kind === "contains") {
      if (definition.type !== "string") {
        throw new Error(`contains() is only supported for string fields: ${parsed.field}`);
      }

      return {
        [parsed.field]: {
          contains: parsed.value,
          mode: "insensitive",
        },
      };
    }

    const value = parseComparisonValue(parsed.field, parsed.value, definition);

    if (parsed.operator === "eq") {
      return { [parsed.field]: value };
    }

    return {
      [parsed.field]: {
        [parsed.operator]: value,
      },
    };
  });

  return filters.length === 1 ? filters[0] : { AND: filters };
}

export function parseODataSelect(select: string | undefined, allowedFields: string[]): string[] | undefined {
  const normalized = select?.trim();
  if (!normalized) return undefined;

  const requested = normalized
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);

  if (requested.length === 0) return undefined;

  const allowed = new Set(allowedFields);
  const result: string[] = [];
  for (const field of requested) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) {
      throw new Error(`Unsupported $select field: ${field}`);
    }
    if (!allowed.has(field)) {
      throw new Error(`Unsupported $select field: ${field}`);
    }
    if (!result.includes(field)) result.push(field);
  }

  return result;
}

export function encodeCursor(id: number): string {
  return Buffer.from(JSON.stringify({ id }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): number | undefined {
  const normalized = cursor?.trim();
  if (!normalized) return undefined;

  try {
    const decoded = JSON.parse(Buffer.from(normalized, "base64url").toString("utf8"));
    if (typeof decoded.id === "number" && Number.isInteger(decoded.id)) {
      return decoded.id;
    }
  } catch {
    // Treat malformed cursors as absent so the route can fall back cleanly.
  }

  return undefined;
}

export function projectRecord<T extends Record<string, unknown>>(
  record: T,
  select: string[] | undefined,
  derived: Record<string, (row: T) => unknown> = {}
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  const selectedFields = select?.length ? select : Object.keys(record);

  for (const field of selectedFields) {
    if (field in record) {
      projected[field] = record[field];
      continue;
    }

    const compute = derived[field];
    if (compute) {
      projected[field] = compute(record);
    }
  }

  if (!select?.length) {
    for (const [field, compute] of Object.entries(derived)) {
      projected[field] = compute(record);
    }
  }

  return projected;
}