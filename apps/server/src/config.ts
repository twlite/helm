import { z } from 'zod';

const envSchema = z.object({
  AGENT_MAX_STEPS: z.coerce.number().int().positive().default(50),
  AGENT_CONTEXT_RECENT_MESSAGES: z.coerce.number().int().positive().default(24),
  CHROMA_URL: z.url().default('http://localhost:8000'),
  CLIENT_ORIGIN: z.url().optional(),
  DB_PATH: z.string().default('helm.db'),
  EMBED_MODEL: z.string().min(1),
  LLM_BASE_URL: z.url(),
  MEMORY_COLLECTION: z.string().default('helm_memory'),
  MEMORY_TOP_K: z.coerce.number().int().positive().default(4),
  MODEL_PROVIDER: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_SERVER_URL: z.url().optional(),
  RUN_STREAM_PING_MS: z.coerce.number().int().positive().default(15_000),
  SUMMARY_COLLECTION: z.string().default('helm_summaries'),
  SUMMARY_KEEP_RECENT_MESSAGES: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(10),
  SUMMARY_TRIGGER_TOKENS: z.coerce.number().int().positive().default(9000),
  VLM_MODEL: z.string().min(1),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('Invalid server environment configuration');
  console.error(parsedEnv.error.format());
  throw new Error(
    'Server configuration is invalid. Check environment variables.',
  );
}

export const config = parsedEnv.data;
