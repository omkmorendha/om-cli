/**
 * Shared output-truncation policy for tools (spec tools.html §11).
 *
 * Tool output that flows back to the model is capped so a single oversized
 * `read` or a noisy `bash` run cannot blow the context window. The policy is
 * uniform and lives here so every tool truncates identically.
 *
 *   - Byte cap: MAX_TOOL_BYTES (~30 KB) of UTF-8 model-facing content.
 *   - Head + tail: keep the first ~20 KB and last ~10 KB, drop the middle.
 *   - Notice: a single line marks the cut and how much was removed.
 *   - truncated flag set whenever a cut occurred.
 *
 * Byte slicing snaps to the nearest UTF-8 codepoint boundary so the notice
 * never splits a multibyte character.
 */

export const MAX_TOOL_BYTES = 30_000;
export const HEAD = 20_000;
export const TAIL = 10_000;

/** Human-readable byte size, e.g. 1234 -> "1.2 KB". */
export function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * Slice a string by UTF-8 byte offsets [start, end), snapping each end inward
 * to the nearest codepoint boundary so a multibyte character is never split.
 */
export function sliceBytes(s: string, start: number, end: number): string {
  const buf = Buffer.from(s, "utf8");
  const lo = clampToBoundary(buf, Math.max(0, Math.min(start, buf.length)), "up");
  const hi = clampToBoundary(buf, Math.max(0, Math.min(end, buf.length)), "down");
  if (hi <= lo) return "";
  return buf.toString("utf8", lo, hi);
}

/**
 * Move an index to a UTF-8 codepoint boundary. A continuation byte has the
 * high bits 10xxxxxx (0x80..0xBF). "up" advances forward off a continuation
 * byte (used for the start of a slice); "down" retreats backward (used for the
 * end of a slice). This keeps both ends on real character boundaries so we
 * never emit a lone continuation byte that would render as U+FFFD.
 */
function clampToBoundary(buf: Buffer, idx: number, dir: "up" | "down"): number {
  const isCont = (i: number): boolean => {
    const b = buf[i];
    return b !== undefined && (b & 0xc0) === 0x80;
  };
  if (dir === "up") {
    let i = idx;
    while (i < buf.length && isCont(i)) i++;
    return i;
  }
  let i = idx;
  while (i > 0 && isCont(i)) i--;
  return i;
}

export interface TruncateResult {
  content: string;
  truncated: boolean;
}

/**
 * Apply the head+tail byte cap. Under the cap the string passes through
 * unchanged; over it, returns head + notice + tail with truncated:true.
 */
export function truncate(s: string): TruncateResult {
  const bytes = Buffer.byteLength(s, "utf8");
  if (bytes <= MAX_TOOL_BYTES) return { content: s, truncated: false };
  const head = sliceBytes(s, 0, HEAD);
  const tail = sliceBytes(s, bytes - TAIL, bytes);
  const dropped = bytes - HEAD - TAIL;
  const notice = `\n\n… [truncated ${human(dropped)} of output] …\n\n`;
  return { content: head + notice + tail, truncated: true };
}
