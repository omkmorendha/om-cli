/**
 * Tests for the TUI theme module. The theme is plain data (no OpenTUI), so these
 * pin the small bits of logic — spinner frame wraparound and the tool-color
 * fallback — plus a couple of palette invariants that the rest of the TUI relies
 * on (e.g. distinct semantic accents).
 */

import { describe, expect, test } from "bun:test";
import {
  colorForTool,
  glyph,
  palette,
  spinnerFrame,
  spinnerFrames,
  SPINNER_INTERVAL_MS,
} from "./theme.ts";

describe("spinnerFrame", () => {
  test("wraps around the frame set", () => {
    expect(spinnerFrame(0)).toBe(spinnerFrames[0]);
    expect(spinnerFrame(spinnerFrames.length)).toBe(spinnerFrames[0]);
    expect(spinnerFrame(spinnerFrames.length + 2)).toBe(spinnerFrames[2]);
  });

  test("handles negative ticks without throwing or returning undefined", () => {
    const f = spinnerFrame(-1);
    expect(typeof f).toBe("string");
    expect(f.length).toBeGreaterThan(0);
  });

  test("interval is a sane, positive cadence", () => {
    expect(SPINNER_INTERVAL_MS).toBeGreaterThan(0);
    expect(SPINNER_INTERVAL_MS).toBeLessThan(1000);
  });
});

describe("colorForTool", () => {
  test("known tools get their accent", () => {
    expect(colorForTool("read")).toBe(palette.blue);
    expect(colorForTool("bash")).toBe(palette.purple);
    expect(colorForTool("edit")).toBe(palette.green);
  });

  test("unknown tools fall back to muted", () => {
    expect(colorForTool("totally-unknown")).toBe(palette.muted);
  });
});

describe("palette / glyphs", () => {
  test("every palette value is a 6-digit hex color", () => {
    for (const [name, value] of Object.entries(palette)) {
      expect(value, `${name} should be #rrggbb`).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  test("semantic accents are distinct from the base foreground", () => {
    expect(palette.green).not.toBe(palette.fg);
    expect(palette.red).not.toBe(palette.fg);
    expect(palette.blue).not.toBe(palette.fg);
  });

  test("glyphs are single non-empty strings", () => {
    for (const [name, value] of Object.entries(glyph)) {
      expect(value.length, `${name} glyph non-empty`).toBeGreaterThan(0);
    }
  });
});
