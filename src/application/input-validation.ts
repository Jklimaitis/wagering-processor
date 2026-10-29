export class InvalidInputError extends Error {
  readonly code = "INVALID_INPUT";

  constructor(readonly field: string) {
    super(`Campo inválido: ${field}`);
    this.name = "InvalidInputError";
  }
}

export function readObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidInputError(field);
  }

  return value as Record<string, unknown>;
}

export function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidInputError(field);
  }

  return value;
}

export function readUuid(value: unknown, field: string): string {
  const text = readString(value, field);

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      text,
    )
  ) {
    throw new InvalidInputError(field);
  }

  return text.toLowerCase();
}
