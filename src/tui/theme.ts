/**
 * TUI theme — the single source of truth for the OpenTUI frontend's look.
 *
 * The palette is GitHub's "dark dimmed" set, chosen so the running TUI reads as
 * the same product as the `spec/` wiki (whose pages use exactly these hex
 * values). Every color the TUI paints flows from here; tui.ts never hard-codes a
 * hex literal of its own. Keeping it in one tiny, dependency-free module also
 * means the values can be asserted in a unit test without a renderer.
 *
 * Nothing here touches OpenTUI: these are plain strings and arrays so the module
 * is trivially importable from tests and from the headless path alike.
 */

/** Core palette. Names mirror the spec wiki's CSS custom properties. */
export const palette = {
  /** App background (alt-screen fill). */
  bg: "#0d1117",
  /** Slightly raised surface — cards, status bar, approval bar. */
  surface: "#161b22",
  /** A second raised step for nested fills (card bodies, code). */
  surfaceAlt: "#1c2128",
  /** Hairline borders and separators. */
  border: "#30363d",
  /** Primary foreground text. */
  fg: "#e6edf3",
  /** Secondary / muted text (hints, metadata, descriptions). */
  muted: "#9da7b3",
  /** Even dimmer text (placeholders, disabled). */
  faint: "#6e7681",

  // Accents.
  green: "#7ee787",
  red: "#ff7b72",
  blue: "#79c0ff",
  purple: "#d2a8ff",
  orange: "#ffa657",
  yellow: "#e3b341",
  cyan: "#56d4dd",
  pink: "#ff9bce",
} as const;

/**
 * Semantic role colors — who is "speaking" in the scrollback. The user prompt,
 * the assistant, the system, and error lines each get a stable accent so the
 * conversation is scannable at a glance.
 */
export const roleColor = {
  user: palette.blue,
  assistant: palette.fg,
  system: palette.purple,
  error: palette.red,
} as const;

/**
 * A stable accent per tool name, used for the tool-card title/glyph. Read-only
 * tools lean cool (blue/cyan), mutating tools lean warm (orange/green), exec is
 * purple to stand out as the one that runs arbitrary commands. Unknown tools
 * fall back to {@link palette.muted}.
 */
export const toolColor: Record<string, string> = {
  read: palette.blue,
  write: palette.orange,
  edit: palette.green,
  bash: palette.purple,
  glob: palette.cyan,
  grep: palette.cyan,
  ls: palette.cyan,
};

/** Resolve a tool's accent color, defaulting to muted for unknown tools. */
export function colorForTool(name: string): string {
  return toolColor[name] ?? palette.muted;
}

/**
 * Status colors for a tool card's result line: running (in-flight), ok, and
 * error. These also drive the card's border so a failed call is visible without
 * reading the text.
 */
export const statusColor = {
  running: palette.yellow,
  ok: palette.green,
  error: palette.red,
} as const;

/**
 * Glyphs. A small, deliberately ASCII-safe-ish set (these are common Nerd-free
 * Unicode that virtually every modern terminal renders). Kept here so the visual
 * vocabulary is consistent and swappable in one place.
 */
export const glyph = {
  /** User prompt marker. */
  user: "❯",
  /** Assistant reply marker. */
  assistant: "✦",
  /** Tool card marker. */
  tool: "▸",
  /** Result success / failure markers. */
  ok: "✓",
  err: "✗",
  /** Approval prompt marker. */
  approval: "?",
  /** Error line marker. */
  error: "✗",
  /** Bullet for hints/metadata. */
  dot: "·",
  /** Right-pointing separator used in the header. */
  sep: "›",
} as const;

/**
 * Spinner animation frames (Braille dots). Cycled by the status bar and by each
 * in-flight tool card. The whole set is one smooth rotation.
 */
export const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Milliseconds between spinner frame advances. ~12.5 fps feels lively but calm. */
export const SPINNER_INTERVAL_MS = 80;

/** Return the spinner frame for a given tick index (wraps automatically). */
export function spinnerFrame(tick: number): string {
  const n = spinnerFrames.length;
  return spinnerFrames[((tick % n) + n) % n] ?? spinnerFrames[0];
}
