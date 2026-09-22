import { asSchema, jsonSchema, type JSONSchema7, type Schema } from 'ai';
import type { z } from 'zod';

export type StructuredOutputCompatibility = 'native' | 'lmstudio-mlx';

const schemaMapKeywords = [
  'properties',
  'patternProperties',
  'definitions',
  '$defs',
  'dependentSchemas',
  'dependencies',
] as const;

const schemaValueKeywords = [
  'additionalProperties',
  'items',
  'additionalItems',
  'contains',
  'not',
  'if',
  'then',
  'else',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contentSchema',
] as const;

const schemaArrayKeywords = [
  'allOf',
  'anyOf',
  'oneOf',
  'prefixItems',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function visitSchemaValue(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      visitSchemaValue(item);
    }
    return;
  }
  if (isRecord(value)) {
    stripPropertyNames(value);
  }
}

function stripPropertyNames(schema: Record<string, unknown>): void {
  // MLX's structured decoder rejects this keyword, while JSON object keys are
  // already strings by definition. Do not touch any other constraints.
  delete schema.propertyNames;

  for (const keyword of schemaMapKeywords) {
    const value = schema[keyword];
    if (!isRecord(value)) continue;
    for (const child of Object.values(value)) {
      visitSchemaValue(child);
    }
  }

  for (const keyword of schemaValueKeywords) {
    visitSchemaValue(schema[keyword]);
  }

  for (const keyword of schemaArrayKeywords) {
    visitSchemaValue(schema[keyword]);
  }
}

/**
 * Returns the schema sent to a structured-output provider.
 *
 * The native path returns the AI SDK schema untouched. The MLX path clones it
 * first and removes only the known unsupported `propertyNames` keyword.
 */
export function adaptStructuredOutputJsonSchema(
  schema: JSONSchema7,
  compatibility: StructuredOutputCompatibility,
): JSONSchema7 {
  if (compatibility === 'native') {
    return schema;
  }

  const compatibleSchema = structuredClone(schema) as Record<string, unknown>;
  stripPropertyNames(compatibleSchema);
  return compatibleSchema as JSONSchema7;
}

/**
 * Keeps AI SDK's original schema validator while adapting only the provider
 * facing JSON Schema. This preserves the public Zod response contract.
 */
export function structuredOutputSchema<T extends z.ZodType>(
  schema: T,
  compatibility: StructuredOutputCompatibility = 'native',
): Schema<z.infer<T>> {
  const nativeSchema = asSchema<z.infer<T>>(schema);
  if (compatibility === 'native') {
    return nativeSchema as Schema<z.infer<T>>;
  }

  const jsonSchemaFactory = async () => adaptStructuredOutputJsonSchema(
    await nativeSchema.jsonSchema,
    compatibility,
  );
  if (nativeSchema.validate === undefined) {
    return jsonSchema<z.infer<T>>(jsonSchemaFactory);
  }
  return jsonSchema<z.infer<T>>(jsonSchemaFactory, { validate: nativeSchema.validate });
}
