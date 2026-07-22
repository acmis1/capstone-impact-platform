import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

function parseHexColor(hex: string): [number, number, number] {
  const cleanHex = hex.trim().replace(/^#/, "");
  if (cleanHex.length === 3) {
    const r = parseInt(cleanHex[0] + cleanHex[0], 16);
    const g = parseInt(cleanHex[1] + cleanHex[1], 16);
    const b = parseInt(cleanHex[2] + cleanHex[2], 16);
    return [r, g, b];
  }
  if (cleanHex.length === 6) {
    const r = parseInt(cleanHex.substring(0, 2), 16);
    const g = parseInt(cleanHex.substring(2, 4), 16);
    const b = parseInt(cleanHex.substring(4, 6), 16);
    return [r, g, b];
  }
  throw new Error(`Invalid hex color: ${hex}`);
}

function getRelativeLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((val) => {
    const s = val / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function getContrastRatio(hex1: string, hex2: string): number {
  const lum1 = getRelativeLuminance(parseHexColor(hex1));
  const lum2 = getRelativeLuminance(parseHexColor(hex2));
  const lighter = Math.max(lum1, lum2);
  const darker = Math.min(lum1, lum2);
  return (lighter + 0.05) / (darker + 0.05);
}

function extractCssTokens(): Record<string, string> {
  const cssPath = path.resolve(__dirname, "../app/globals.css");
  const cssContent = fs.readFileSync(cssPath, "utf-8");
  const rootBlockMatch = cssContent.match(/:root\s*\{([^}]+)\}/);
  if (!rootBlockMatch) {
    throw new Error("Could not find :root block in globals.css");
  }

  const tokens: Record<string, string> = {};
  const lines = rootBlockMatch[1].split("\n");
  for (const line of lines) {
    const match = line.match(/--([a-z0-9-]+)\s*:\s*([^;]+);/i);
    if (match) {
      tokens[match[1].trim()] = match[2].trim();
    }
  }
  return tokens;
}

describe("Design Token WCAG 2.2 AA Contrast Verification", () => {
  const tokens = extractCssTokens();

  const pairsToVerify = [
    { name: "background / foreground", bg: "background", fg: "foreground" },
    { name: "card / card-foreground", bg: "card", fg: "card-foreground" },
    { name: "muted / muted-foreground", bg: "muted", fg: "muted-foreground" },
    { name: "primary / primary-foreground", bg: "primary", fg: "primary-foreground" },
    { name: "secondary / secondary-foreground", bg: "secondary", fg: "secondary-foreground" },
    { name: "destructive / destructive-foreground", bg: "destructive", fg: "destructive-foreground" },
    { name: "success / success-foreground", bg: "success", fg: "success-foreground" },
    { name: "warning / warning-foreground", bg: "warning", fg: "warning-foreground" },
    { name: "information / information-foreground", bg: "information", fg: "information-foreground" },
  ];

  for (const pair of pairsToVerify) {
    it(`verifies ${pair.name} meets 4.5:1 contrast ratio`, () => {
      const bgHex = tokens[pair.bg];
      const fgHex = tokens[pair.fg];
      expect(bgHex, `Missing token: --${pair.bg}`).toBeDefined();
      expect(fgHex, `Missing token: --${pair.fg}`).toBeDefined();

      const ratio = getContrastRatio(bgHex, fgHex);
      expect(
        ratio,
        `Token pair '${pair.name}' (${bgHex} vs ${fgHex}) has contrast ratio ${ratio.toFixed(2)}:1, expected >= 4.5:1`
      ).toBeGreaterThanOrEqual(4.5);
    });
  }
});
