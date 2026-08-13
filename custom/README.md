# Custom pi configuration

Personal pi configuration backup, kept in sync with `~/.pi/agent/`.

> **Security note:** `auth.json` / `models.json` (API keys) are **not** committed.
> Restore them locally if you clone this repo to a new machine.

## Contents

| File | Description |
| --- | --- |
| `agent/AGENTS.md` | Global agent instructions (proxy/network rules, etc.) |
| `agent/settings.json` | TUI settings (theme, hidden thinking blocks, default provider/model) |
| `agent/extensions/hidden-thinking-label.ts` | Hidden thinking label extension: live token count + **tokens/sec**, rendered as an animated flowing rainbow gradient |

## Install

Copy the contents into your pi agent directory:

```bash
# Windows (PowerShell)
Copy-Item -Recurse custom/agent/* $HOME\.pi\agent\

# macOS / Linux
cp -r custom/agent/* ~/.pi/agent/
```

## hidden-thinking-label.ts highlights

While the model thinks, the collapsed thinking-block label shows:

```
Thinking… 5.3k tokens 122 t/s
```

- Token count prefers provider-reported `usage.reasoning`, falls back to a
  character-based estimate while streaming.
- The `t/s` figure is computed over a 5-second sliding window and refreshed
  once per second.
- The whole label is colored as a rainbow gradient (per-character hue) that
  flows continuously (≈3s per full cycle).
- When thinking finishes, the label pins to a static rainbow
  `Thought 5.3k tokens`.

Tunables at the top of the file:

| Constant | Default | Meaning |
| --- | --- | --- |
| `TICK_MS` | 50 | rainbow animation frame interval |
| `HUE_STEP` | 6 | hue shift per frame (flow speed) |
| `HUE_PER_CHAR` | 12 | hue difference between adjacent characters |
| `RATE_WINDOW_MS` | 5000 | sliding window for the t/s estimate |
| `RATE_UPDATE_MS` | 1000 | how often the t/s figure refreshes |

Commands:

- `/thinking-label <text>` — set a fixed label (disables auto display)
- `/thinking-label` — re-enable automatic token labels
