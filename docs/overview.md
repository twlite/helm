# Helm — Project Overview

## What is Helm?

Helm is an agentic desktop automation system that lets a language model observe, reason about, and control a Linux desktop environment entirely through tool calls. The operator communicates a high-level goal in natural language; Helm autonomously breaks the goal into a sequence of visual actions, executes them on the desktop, verifies each step by capturing a screenshot, and stops only when the goal is visibly complete.

The system is designed around three ideas that distinguish it from simpler script-based automation:

1. **Vision-Language reasoning.** Every decision is grounded in a live screenshot of the desktop. The model sees what a human would see and infers the correct next action from the visual state — no fragile DOM selectors, no recorded macros.

2. **ReAct planning loop.** The agent alternates between *Reasoning* (what do I see and what should I do next?) and *Acting* (issue one tool call) in a tight loop. After each action it captures a new screenshot to verify the effect before continuing. This mirrors the classic ReAct (Reason + Act) paradigm and makes the agent robust to unexpected UI changes.

3. **Episodic memory via RAG.** After each run the agent persists what it observed and did into a vector database (ChromaDB). Semantically similar memories are retrieved at the start of future runs, giving the agent cross-session recall without any fine-tuning.

## Key Capabilities

| Capability | Description |
|------------|-------------|
| Visual control | Moves the mouse, clicks, types text, opens applications, captures screenshots |
| Browser navigation | Opens Firefox, navigates to URLs, interacts with web pages visually |
| Terminal commands | Runs shell commands in a visible terminal or silently via a direct executor |
| File operations | Creates, reads, and deletes files without opening a visible editor |
| Multi-step reasoning | Plans and executes sequences of actions with screenshot verification at each step |
| Episodic memory | Persists run episodes and semantic embeddings; retrieves relevant memories on future runs |
| Context compression | Automatically summarises long conversations to keep the active token window manageable |
| Message queuing | Users can queue follow-up instructions that are delivered automatically when the current run finishes |
| Custom instructions | Users can inject high-priority rules that are appended to the system prompt at runtime |

## Motto

> Agentic desktop automation using Vision-Language Models, ReAct planning, and episodic memory via RAG.

## Repository Layout

```
helm/
├── apps/
│   ├── client/          # React frontend (Vite, Tailwind, shadcn/ui)
│   └── server/          # Hono API server (Bun runtime)
│       └── src/
│           ├── agent/   # Core agent: model, prompt, runtime, tools
│           ├── database/# SQLite store (better-sqlite3)
│           ├── desktop/ # Desktop control service abstraction
│           ├── routes/  # HTTP API route handlers
│           └── services/# Memory, summariser, event bus, run control
├── packages/            # Shared TypeScript packages (if any)
├── agent/               # Docker-based Linux desktop environment
├── docker-compose.yml   # Service composition (VNC, ChromaDB, Helm server)
└── docs/                # Project documentation (this folder)
```
