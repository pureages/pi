# Custom pi configuration

Personal pi configuration backup, kept in sync with `~/.pi/agent/`.

> **Security note:** `auth.json` / `models.json` (real API keys) and `sessions/`
> are **not** committed — use the redacted `models.example.json` template
> instead. Restore your real keys locally after cloning to a new machine.

## Contents

| File | Description |
| --- | --- |
| `agent/AGENTS.md` | Global agent instructions (proxy fallback, command timeout rules, etc.) |
| `agent/settings.json` | TUI settings (theme, hidden thinking blocks, default provider/model, compaction) |
| `agent/models.example.json` | Provider/model definitions template — **API keys redacted**, fill `YOUR_API_KEY_HERE` and save as `models.json` |
| `agent/models-store.json` | Model catalog cache (opencode-go / minimax-cn / qwen-token-plan-cn), no secrets |
| `agent/extensions/hidden-thinking-label.ts` | Hidden thinking label extension: **per-message** live token count + tokens/sec, rainbow gradient |
| `agent/extensions/pureages-video-watcher.ts` | Video watcher tool: samples frames with ffmpeg so the agent can "watch" a local video |
| `agent/extensions/ssh.ts` | Delegate read/write/edit/bash to a remote machine over SSH (`--ssh user@host`) |
| `agent/extensions/titlebar-spinner.ts` | Terminal-title braille spinner while the agent is working |

## Install

Copy the contents into your pi agent directory:

```bash
# Windows (PowerShell)
Copy-Item -Recurse custom/agent/* $HOME\.pi\agent\

# macOS / Linux
cp -r custom/agent/* ~/.pi/agent/
```

Then restore your secrets locally (they are never committed):

```bash
# 1. put your real API keys back
cp ~/.pi/agent/auth.json   # from a backup, or let pi re-auth interactively
# 2. fill in models.json from the template
cp ~/.pi/agent/models.example.json ~/.pi/agent/models.json
#    ... then replace YOUR_API_KEY_HERE with your real keys
```

## hidden-thinking-label.ts highlights

While the model thinks, the collapsed thinking-block label shows:

```
Thinking… 5.3k tokens 122 t/s
```

- Token count prefers provider-reported `usage.reasoning`, falls back to a
  character-based estimate while streaming.
- `t/s` is computed over a 5-second sliding window, refreshed once per second.
- **Per-message labels**: each finished assistant message keeps its own final
  token count (`Thought 5.3k tokens`) instead of inheriting later messages'
  counts — implemented by patching `AssistantMessageComponent` to capture live
  instances and re-applying each message's stored label after global updates.
  Falls back to the global-label behavior if the patch can't be installed.
- The whole label is colored as a rainbow gradient (per-character hue) that
  flows continuously (≈3s per full cycle).

Commands:

- `/thinking-label <text>` — set a fixed label (disables auto display)
- `/thinking-label` — re-enable automatic token labels

## pureages-video-watcher.ts highlights

Custom tool `watch_video` that lets pi actually *see* a video:

- Uses system `ffmpeg` to sample frames (default 1 frame / 6 s, min 6 frames
  for short clips, `maxFrames` cap 30).
- Returns frames as images scaled to `maxEdge` (default 768) to control token
  usage; optional `start` / `end` to inspect only a time range.
- Supports mp4/mov/webm/mkv; requires `ffmpeg` on PATH.

## ssh.ts highlights

Runs the built-in read/write/edit/bash tools on a remote host:

```
pi -e ./ssh.ts --ssh user@host
pi -e ./ssh.ts --ssh user@host:/remote/path
```

Requires SSH key-based auth (no password prompts) and `bash` on the remote.