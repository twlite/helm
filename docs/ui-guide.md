# Helm — User Interface Guide

## Layout

The Helm interface is divided into two main panels separated by a draggable resizer:

```
┌─────────────────────────────────────────────────────────────────┐
│  Header: title · agent status · model info · settings · theme  │
├─────────────────────┬───────────────────────────────────────────┤
│  Left panel         │  Right panel                              │
│                     │                                           │
│  Chat history  OR   │  Live desktop view (VNC)                  │
│  Agent chat         │                                           │
│                     │  Blue animated haze appears at top        │
│                     │  and bottom when agent is active          │
└─────────────────────┴───────────────────────────────────────────┘
```

The layout switches between horizontal (side-by-side) and vertical (stacked) based on screen width.

## Left Panel: Chat History

The chat history panel lists all conversations. Each entry shows:
- **Title**: derived from the first user message or auto-generated.
- **Status dot**: coloured indicator showing the conversation's state.
  - Grey: idle or cancelled
  - Blue + pulsing: currently running
  - Green: completed
  - Red: failed
- **Relative timestamp**: e.g. "5m ago", "2h ago", "3d ago".

Actions available:
- **Click** a conversation to open it.
- **New task** button (top-right) to create a fresh conversation.
- **Delete** button (hover over a conversation) to remove it.
- **Memories** link to navigate to the memory browser page.

## Left Panel: Agent Chat

Once a conversation is open, the left panel switches to the agent chat view.

### Message Types

**User messages** appear right-aligned with a secondary background.

**Assistant messages** appear left-aligned and may contain multiple parts:

| Part | Appearance | Interaction |
|------|-----------|-------------|
| Text | Markdown-rendered prose | — |
| Reasoning | Collapsible panel with brain icon | Click to expand/collapse; shows numbered reasoning steps |
| Tool activity | Compact card with tool call summary and latest screenshot | Expand "Show detailed tool log" for per-tool input/output |
| Memory / context events | Coloured expandable chip | Click to reveal detail |
| Attachment | File card with preview | — |

### Status Chips (Expandable)

When the agent interacts with the memory system or compresses context, a status chip appears inline. Click any chip to see the detail:

| Chip | Colour | What it shows when expanded |
|------|--------|----------------------------|
| 🧠 Reading memory | Purple | Number of memories retrieved + query text |
| 💾 Memory saved | Green | Number of tool calls recorded in the episode |
| 📦 Compressing context | Amber | Token estimate being compressed |
| ✅ Context compressed | Green | Messages covered + summary token size |

### Message Queue

Below the conversation and above the composer, a queue panel appears when messages are queued. The queue:
- Shows pending messages in order.
- **Auto-submits** the first message in the queue when the agent finishes the current run (transitions from busy to idle).
- Supports **drag-and-drop reordering** by dragging the grip handle on the left.
- Each item has two action buttons:
  - **Arrow (→)**: send this message immediately, interrupting the queue order.
  - **✕**: remove the message from the queue.

To add a message to the queue, type in the small "Queue next message…" input below the main composer and press Enter or click **Queue**. This is useful for pre-loading a sequence of instructions to run back-to-back.

### Composer

The main composer at the bottom sends a message immediately (or cancels if the agent is running).

- **Textarea**: type the user goal here. Supports multi-line input.
- **Attachment button**: opens a menu to attach files or capture the current desktop screenshot as an attachment.
- **Brain toggle**: enables or disables the model's reasoning mode. When enabled (amber), the model emits extended reasoning text before each action.
- **Submit / Stop button**: submits the message when idle; shows as a red stop button when the agent is running.
- **Context summary icon**: a small circular progress indicator (bottom-right of the composer) showing what percentage of the conversation has been compressed into a summary. Hover over it to see a card with full context statistics.

## Right Panel: Desktop VNC

The right panel embeds a noVNC iframe showing the live state of the Linux desktop container.

- The user can interact with the VNC view directly (if noVNC is configured for input).
- A **blue animated haze** appears at the top and bottom of the VNC frame whenever the agent is active (any status other than idle). This provides a visual signal that the agent is working on the desktop.

## Header

The header bar contains:
- **Conversation title** (current active conversation).
- **Agent status indicator**: a coloured dot with a label (Idle / Starting… / Thinking… / Working… / Responding… / Reading memory… / Compressing context… / Cancelling…).
- **Model info**: the model name and provider fetched from `/api/info`.
- **Settings button**: opens a modal with:
  - **Custom instructions** textarea: rules appended to every run's system prompt at high priority. Stored in browser `localStorage`.
  - **Server info panel**: model name, provider, embedding model, summary trigger threshold.
- **Theme toggle**: switches between light and dark mode.

## Memories Page (`/memories`)

Navigate to the memories page via the "Memories" link in the chat history panel.

The page displays all stored memory entries grouped by collection. Features:
- **Filter tabs**: filter by collection (All / Semantic memory / Episode log / Summary).
- **Expandable rows**: click any entry to load and display its stored text from ChromaDB.
- **Delete button**: removes the entry from both ChromaDB and the SQLite tracking table.
- **Relative timestamps**: each entry shows when it was created.
- **Entity type badges**: colour-coded tags indicating the memory's origin (user input, assistant output, episode, summary).

## URL Routing

| Path | View |
|------|------|
| `/` | Redirects to the most recent or newly created conversation |
| `/conversations/:id` | Opens the dashboard with the specified conversation active |
| `/memories` | Memory browser page |

Conversations are deep-linkable — sharing a `/conversations/:id` URL opens that specific conversation directly.
