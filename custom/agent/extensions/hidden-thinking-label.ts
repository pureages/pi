/**
 * Hidden Thinking Token Label Extension
 *
 * Shows the number of thinking tokens in the label of hidden thinking blocks,
 * Claude Code style:
 *   - while the model is thinking:  "Thinking… 5.3k tokens 122 t/s" (live count + rate)
 *   - once it finishes:             "Thought 5.3k tokens" (final count)
 *
 * While thinking, the label is rendered as an animated rainbow gradient:
 * every character gets its own hue and the whole palette slowly flows,
 * for a colorful, multicolored feel. The tokens/second figure is computed
 * over a sliding window and refreshed once per second.
 *
 * The count prefers the provider-reported `usage.reasoning` (OpenAI
 * `reasoning_tokens`, Anthropic `thinking_tokens`, etc.) and falls back to a
 * character-based estimate while streaming, since most providers only report
 * usage in the final chunk.
 *
 * Usage:
 *   pi --extension examples/extensions/hidden-thinking-label.ts
 *
 * Test:
 *   1. Load this extension
 *   2. Hide thinking blocks with Ctrl+T
 *   3. Ask for something that produces reasoning output
 *   4. The collapsed thinking block label shows the live token count while
 *      thinking, then the final count when the reply completes
 *
 * Commands:
 *   /thinking-label <text>   Set a fixed label (disables auto token display)
 *   /thinking-label          Re-enable automatic token labels
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_LABEL = "Pondering...";

// --- Animated rainbow gradient -------------------------------------------------

const TICK_MS = 50; // animation frame interval
const HUE_STEP = 6; // hue shift per tick -> full rainbow cycle every 3s
const HUE_PER_CHAR = 12; // hue difference between adjacent characters
const SATURATION = 100; // percent
const LIGHTNESS = 55; // percent

/** Convert HSL (h: 0-360, s/l: 0-100) to 8-bit RGB. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
	h = ((h % 360) + 360) % 360;
	const c = ((1 - Math.abs((2 * l) / 100 - 1)) * s) / 100;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l / 100 - c / 2;
	let r = 0, g = 0, b = 0;
	if (h < 60) { r = c; g = x; }
	else if (h < 120) { r = x; g = c; }
	else if (h < 180) { g = c; b = x; }
	else if (h < 240) { g = x; b = c; }
	else if (h < 300) { r = x; b = c; }
	else { r = c; b = x; }
	return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/**
 * Color every character with its own hue, shifted by `phase` (0-360).
 * The same text with a larger `phase` looks like the rainbow is flowing.
 */
function rainbowize(text: string, phase: number): string {
	let out = "";
	let i = 0;
	for (const ch of text) {
		const hue = (phase + i * HUE_PER_CHAR) % 360;
		const [r, g, b] = hslToRgb(hue, SATURATION, LIGHTNESS);
		out += `\x1b[38;2;${r};${g};${b}m${ch}\x1b[39m`;
		i++;
	}
	return out;
}

// --- Animation state -----------------------------------------------------------

let animTimer: ReturnType<typeof setInterval> | undefined;
let rateTimer: ReturnType<typeof setInterval> | undefined;
let huePhase = 0;
let currentLabel = DEFAULT_LABEL;
let currentCtx: { ui: { setHiddenThinkingLabel(label?: string): void } } | null = null;

function renderRainbowTick() {
	if (!currentCtx) return;
	currentCtx.ui.setHiddenThinkingLabel(rainbowize(currentLabel, huePhase));
	huePhase = (huePhase + HUE_STEP) % 360;
}

function startAnimation(ctx: { ui: { setHiddenThinkingLabel(label?: string): void } }, label: string) {
	currentCtx = ctx;
	currentLabel = label;
	if (!animTimer) {
		huePhase = 0;
		renderRainbowTick(); // paint immediately, then keep flowing
		animTimer = setInterval(renderRainbowTick, TICK_MS);
	}
	if (!rateTimer) {
		// Refresh the label text (token count + t/s) once per second;
		// the rainbow tick picks up the new text within the next frame.
		rateTimer = setInterval(() => {
			currentLabel = buildThinkingLabel();
		}, RATE_UPDATE_MS);
	}
}

function stopAnimation(): void {
	if (animTimer) {
		clearInterval(animTimer);
		animTimer = undefined;
	}
	if (rateTimer) {
		clearInterval(rateTimer);
		rateTimer = undefined;
	}
	rateSamples = [];
	lastTokenCount = 0;
}

// --- Tokens-per-second rate ----------------------------------------------------

const RATE_UPDATE_MS = 1000; // refresh the t/s figure once per second
const RATE_WINDOW_MS = 5000; // sliding window used for the rate estimate

interface TokenSample {
	time: number;
	tokens: number;
}

let rateSamples: TokenSample[] = [];
let lastTokenCount = 0;

/** Record a cumulative token count sample, keeping only the last RATE_WINDOW_MS. */
function recordSample(tokens: number): void {
	const now = Date.now();
	rateSamples.push({ time: now, tokens });
	const cutoff = now - RATE_WINDOW_MS;
	while (rateSamples.length > 2 && rateSamples[0].time < cutoff) rateSamples.shift();
}

/** Average tokens/second over the sliding window, or null when not measurable yet. */
function tokensPerSecond(): number | null {
	if (rateSamples.length < 2) return null;
	const first = rateSamples[0];
	const last = rateSamples[rateSamples.length - 1];
	const dt = (last.time - first.time) / 1000;
	if (dt <= 0) return null;
	return Math.max(0, (last.tokens - first.tokens) / dt);
}

/** Current live label, including the t/s figure once a rate is measurable. */
function buildThinkingLabel(): string {
	const base = `Thinking… ${formatTokens(lastTokenCount)} tokens`;
	const rate = tokensPerSecond();
	return rate === null ? base : `${base} ${formatTokens(Math.round(rate))} t/s`;
}

// --- Token counting ------------------------------------------------------------

/** Rough token estimate from text: CJK chars ≈ 1 token, other chars ≈ 4 per token. */
function estimateTokens(text: string): number {
	let cjk = 0;
	let other = 0;
	for (const ch of text) {
		if (/[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7af\u3040-\u30ff\u31f0-\u31ff\uf900-\ufaff\uff00-\uffef]/.test(ch)) {
			cjk++;
		} else {
			other++;
		}
	}
	return Math.ceil(cjk + other / 4);
}

/** Format like Claude Code: 342 -> "342", 1234 -> "1.2k", 15400 -> "15.4k". */
function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	const k = n / 1000;
	return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1).replace(/\.0$/, "")}k`;
}

interface HasThinkingContent {
	content: readonly { type: string; thinking?: string }[];
	usage?: { reasoning?: number };
}

function getThinkingText(message: HasThinkingContent): string {
	let text = "";
	for (const c of message.content) {
		if (c.type === "thinking" && c.thinking) text += c.thinking;
	}
	return text;
}

function getThinkingTokens(message: HasThinkingContent): number {
	const reasoning = message.usage?.reasoning;
	if (typeof reasoning === "number" && reasoning > 0) return reasoning;
	return estimateTokens(getThinkingText(message));
}

export default function (pi: ExtensionAPI) {
	let autoLabel = true; // false once the user sets a fixed label via /thinking-label
	let sawThinking = false; // current assistant message contains thinking

	pi.on("session_start", async (_event, ctx) => {
		stopAnimation();
		ctx.ui.setHiddenThinkingLabel(DEFAULT_LABEL);
	});

	// A new assistant message starts: no thinking seen yet.
	// Reset the (global) label so the new message doesn't inherit the previous
	// message's final count before its own thinking starts.
	pi.on("message_start", async (event, ctx) => {
		if (event.message.role === "assistant") {
			sawThinking = false;
			stopAnimation();
			if (autoLabel) ctx.ui.setHiddenThinkingLabel(DEFAULT_LABEL);
		}
	});

	// While thinking streams, update the label live with the animated rainbow.
	pi.on("message_update", async (event, ctx) => {
		if (!autoLabel) return;
		const ev = event.assistantMessageEvent;
		if (ev.type !== "thinking_start" && ev.type !== "thinking_delta") return;

		const thinkingText = getThinkingText(event.message);
		if (!thinkingText) return;
		sawThinking = true;

		const tokens = getThinkingTokens(event.message);
		lastTokenCount = tokens;
		recordSample(tokens);
		startAnimation(ctx, buildThinkingLabel());
	});

	// When the assistant message finishes, pin the final count with a static rainbow.
	pi.on("message_end", async (event, ctx) => {
		if (!autoLabel) return;
		if (event.message.role !== "assistant" || !sawThinking) return;

		stopAnimation();
		const tokens = getThinkingTokens(event.message);
		ctx.ui.setHiddenThinkingLabel(rainbowize(`Thought ${formatTokens(tokens)} tokens`, huePhase));
	});

	pi.registerCommand("thinking-label", {
		description: "Set a fixed hidden thinking label. Use without args to re-enable automatic token counts.",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				autoLabel = true;
				stopAnimation();
				ctx.ui.setHiddenThinkingLabel(DEFAULT_LABEL);
				ctx.ui.notify("Auto token label enabled.");
				return;
			}
			autoLabel = false;
			stopAnimation();
			// The fixed label is user-chosen: leave it as-is, but keep it in sync.
			currentCtx = ctx;
			currentLabel = args.trim();
			ctx.ui.setHiddenThinkingLabel(args.trim());
			ctx.ui.notify(`Hidden thinking label set to: ${args.trim()}`);
		},
	});
}
