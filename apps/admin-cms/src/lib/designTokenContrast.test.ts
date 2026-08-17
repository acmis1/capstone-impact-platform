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

function compositeOverBackground(fgHex: string, alpha: number, underlyingHex: string): string {
  const [fr, fgc, fb] = parseHexColor(fgHex);
  const [ur, ug, ub] = parseHexColor(underlyingHex);
  const composite = (fgChannel: number, underlyingChannel: number) =>
    Math.round(fgChannel * alpha + underlyingChannel * (1 - alpha));
  const toHexPair = (value: number) => value.toString(16).padStart(2, "0");
  const r = composite(fr, ur);
  const g = composite(fgc, ug);
  const b = composite(fb, ub);
  return `#${toHexPair(r)}${toHexPair(g)}${toHexPair(b)}`;
}

function extractBadgeVariantClassMap(): Record<string, string> {
  const badgePath = path.resolve(__dirname, "../components/ui/badge.tsx");
  const content = fs.readFileSync(badgePath, "utf-8");
  const variantsBlockMatch = content.match(/variant:\s*\{([\s\S]*?)\n\s*\},\s*\n\s*\},/);
  if (!variantsBlockMatch) {
    throw new Error("Could not locate badge `variant` class map in badge.tsx");
  }

  const map: Record<string, string> = {};
  const entryPattern = /(\w+):\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(variantsBlockMatch[1]))) {
    map[match[1]] = match[2];
  }
  return map;
}

function findColorUtility(
  classString: string,
  utilityPrefix: "bg" | "text",
  tokenNames: string[]
): { token: string; opacityPercent: number | null } | null {
  const alternation = [...tokenNames].sort((a, b) => b.length - a.length).join("|");
  const pattern = new RegExp(`\\b${utilityPrefix}-(${alternation})(?:/(\\d+))?\\b`);
  const match = classString.match(pattern);
  if (!match) return null;
  return { token: match[1], opacityPercent: match[2] ? Number(match[2]) : null };
}

describe("Badge rendered alpha-composited contrast (WCAG 2.2 AA)", () => {
  const tokens = extractCssTokens();
  const tokenNames = Object.keys(tokens);
  const badgeClassMap = extractBadgeVariantClassMap();
  // Badges render on the card/white surface throughout project, import, and staff status tables.
  const badgeUnderlyingSurfaceHex = tokens["card"];

  const badgeVariantsToVerify = ["success", "warning", "information", "destructive"];

  for (const variantName of badgeVariantsToVerify) {
    it(`badge variant "${variantName}" achieves >= 4.5:1 rendered text contrast on its actual composited background`, () => {
      const classString = badgeClassMap[variantName];
      expect(classString, `Missing badge variant in badge.tsx: ${variantName}`).toBeDefined();

      const bgUtility = findColorUtility(classString, "bg", tokenNames);
      const textUtility = findColorUtility(classString, "text", tokenNames);
      expect(bgUtility, `Could not find a bg-<token> utility for badge variant "${variantName}"`).not.toBeNull();
      expect(textUtility, `Could not find a text-<token> utility for badge variant "${variantName}"`).not.toBeNull();

      const bgTokenHex = tokens[bgUtility!.token];
      const textTokenHex = tokens[textUtility!.token];
      expect(bgTokenHex, `Missing token: --${bgUtility!.token}`).toBeDefined();
      expect(textTokenHex, `Missing token: --${textUtility!.token}`).toBeDefined();

      const alpha = bgUtility!.opacityPercent !== null ? bgUtility!.opacityPercent / 100 : 1;
      const renderedBgHex =
        alpha < 1 ? compositeOverBackground(bgTokenHex, alpha, badgeUnderlyingSurfaceHex) : bgTokenHex;

      const ratio = getContrastRatio(renderedBgHex, textTokenHex);
      expect(
        ratio,
        `Badge variant "${variantName}" renders text ${textTokenHex} on composited background ${renderedBgHex} ` +
          `(bg-${bgUtility!.token}${bgUtility!.opacityPercent !== null ? `/${bgUtility!.opacityPercent}` : ""} over card ${badgeUnderlyingSurfaceHex}), ` +
          `contrast ratio ${ratio.toFixed(2)}:1, expected >= 4.5:1`
      ).toBeGreaterThanOrEqual(4.5);
    });
  }
});

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
