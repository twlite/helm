declare global {
  namespace NodeJS {
    interface ProcessEnv {
      LLM_BASE_URL: string;
      PORT: string;
      MODEL_PROVIDER: string;
      EMBED_MODEL: string;
      VLM_MODEL: string;
      CHROMA_URL: string;
      DB_PATH?: string;
      DESKTOP_CONTROL_MODE?: 'docker-exec' | 'local';
      DESKTOP_CONTAINER?: string;
      DESKTOP_DISPLAY?: string;
      DESKTOP_COMMAND_TIMEOUT_MS?: string;
      SUMMARY_TRIGGER_TOKENS?: string;
      SUMMARY_KEEP_RECENT_MESSAGES?: string;
      MEMORY_TOP_K?: string;
      AGENT_CONTEXT_RECENT_MESSAGES?: string;
      MEMORY_COLLECTION?: string;
      SUMMARY_COLLECTION?: string;
      AGENT_MAX_STEPS?: string;
      PUBLIC_SERVER_URL?: string;
      RUN_STREAM_PING_MS?: string;
      CLIENT_ORIGIN?: string;
    }
  }
}

export {};
