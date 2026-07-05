import type { JSONSchema7 } from "json-schema";

export function assertMatchesSchema(data: unknown, schema: JSONSchema7): void {
  if (schema.type === "object" && typeof data === "object" && data !== null) {
    const record = data as Record<string, unknown>;
    const required = schema.required ?? [];
    for (const key of required) {
      if (!(key in record)) {
        throw new Error(`Schema validation failed: missing required field "${key}"`);
      }
    }
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (!(key in record)) continue;
        if (typeof propSchema === "boolean") continue;
        validateProperty(record[key], propSchema);
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(record)) {
        if (!allowed.has(key)) {
          throw new Error(
            `Schema validation failed: unexpected field "${key}"`,
          );
        }
      }
    }
    return;
  }
  throw new Error("Schema validation failed: expected object");
}

function validateProperty(value: unknown, schema: JSONSchema7): void {
  if (schema.type === "string" && typeof value !== "string") {
    throw new Error(`Schema validation failed: expected string, got ${typeof value}`);
  }
  if (schema.type === "number" && typeof value !== "number") {
    throw new Error(`Schema validation failed: expected number, got ${typeof value}`);
  }
  if (schema.type === "boolean" && typeof value !== "boolean") {
    throw new Error(`Schema validation failed: expected boolean, got ${typeof value}`);
  }
}
