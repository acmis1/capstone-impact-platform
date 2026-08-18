import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  IMPORT_WORKFLOW_STEP_ITEM_CLASSES,
  IMPORT_WORKFLOW_STEP_SURFACE_TOKEN,
} from "../components/imports/importWorkflowStepStyles";
import {
  PROJECT_DETAIL_SURFACE_CLASSES,
  PROJECT_DETAIL_SURFACE_TOKEN,
  PROJECT_DETAIL_PAGE_TEXT_CLASSES,
  PROJECT_DETAIL_PAGE_SURFACE_TOKEN,
} from "../components/admin/projectDetailSurfaceStyles";
import {
  MEDIA_PREVIEW_CLASSES,
  MEDIA_PREVIEW_SURFACE_TOKEN,
} from "../components/admin-media/mediaPreviewStyles";
import { buttonVariants } from "../components/ui/button";
import { REVIEW_ACTION_PRESENTATIONS } from "../components/admin/reviewActionPresentation";
import { IMPORT_SUMMARY_VALUE_CLASS_NAMES } from "../components/admin/ImportMetricsSummary";

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

function findLastColorUtility(
  classString: string,
  utilityPrefix: "bg" | "text" | "border",
  tokenNames: string[],
  statePrefix = ""
): { token: string; opacityPercent: number | null } | null {
  const alternation = [...tokenNames].sort((a, b) => b.length - a.length).join("|");
  const state = statePrefix ? `${statePrefix}:` : "";
  const stateGuard = statePrefix ? "" : "(?<!:)";
  const pattern = new RegExp(`${stateGuard}\\b${state}${utilityPrefix}-(${alternation})(?:/(\\d+))?\\b`, "g");
  const matches = [...classString.matchAll(pattern)];
  const match = matches.at(-1);
  if (!match) return null;
  return { token: match[1], opacityPercent: match[2] ? Number(match[2]) : null };
}

function renderedBackgroundHex(
  utility: { token: string; opacityPercent: number | null },
  tokens: Record<string, string>,
  underlyingHex: string
) {
  const tokenHex = tokens[utility.token];
  expect(tokenHex, `Missing token: --${utility.token}`).toBeDefined();
  const alpha = utility.opacityPercent !== null ? utility.opacityPercent / 100 : 1;
  return alpha < 1 ? compositeOverBackground(tokenHex, alpha, underlyingHex) : tokenHex;
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

describe("Import workflow step-tracker rendered contrast (WCAG 2.2 AA)", () => {
  const tokens = extractCssTokens();
  const tokenNames = Object.keys(tokens);
  // The step tracker `<nav>` is `bg-card`, so any tinted step background composites over it.
  const trackerSurfaceHex = tokens[IMPORT_WORKFLOW_STEP_SURFACE_TOKEN];

  // Derived from the same exported class map the component renders, so this guard
  // re-evaluates automatically if the step-tracker styling changes. The `current`
  // entry is the specific regression guarded here: `bg-primary/10 text-primary`
  // composited to ~3.90:1 on the card surface, below the 4.5:1 floor for its 12px label.
  const stepStates = Object.keys(IMPORT_WORKFLOW_STEP_ITEM_CLASSES) as Array<
    keyof typeof IMPORT_WORKFLOW_STEP_ITEM_CLASSES
  >;

  for (const stateName of stepStates) {
    it(`step-tracker "${stateName}" item label achieves >= 4.5:1 on its actual rendered background`, () => {
      const classString = IMPORT_WORKFLOW_STEP_ITEM_CLASSES[stateName];

      const textUtility = findColorUtility(classString, "text", tokenNames);
      expect(
        textUtility,
        `Could not find a text-<token> utility for step state "${stateName}" in "${classString}"`
      ).not.toBeNull();

      const textTokenHex = tokens[textUtility!.token];
      expect(textTokenHex, `Missing token: --${textUtility!.token}`).toBeDefined();

      // A step item either paints its own (possibly alpha-tinted) background, or
      // inherits the tracker surface. Both cases are resolved to a real rendered hex.
      const bgUtility = findColorUtility(classString, "bg", tokenNames);
      let renderedBgHex = trackerSurfaceHex;
      let bgDescription = `inherited tracker surface --${IMPORT_WORKFLOW_STEP_SURFACE_TOKEN} ${trackerSurfaceHex}`;

      if (bgUtility) {
        const bgTokenHex = tokens[bgUtility.token];
        expect(bgTokenHex, `Missing token: --${bgUtility.token}`).toBeDefined();
        const alpha = bgUtility.opacityPercent !== null ? bgUtility.opacityPercent / 100 : 1;
        renderedBgHex =
          alpha < 1 ? compositeOverBackground(bgTokenHex, alpha, trackerSurfaceHex) : bgTokenHex;
        bgDescription =
          `bg-${bgUtility.token}${bgUtility.opacityPercent !== null ? `/${bgUtility.opacityPercent}` : ""} ` +
          `(${bgTokenHex} at alpha ${alpha}) composited over ${trackerSurfaceHex} = ${renderedBgHex}`;
      }

      const ratio = getContrastRatio(renderedBgHex, textTokenHex);
      expect(
        ratio,
        `Step state "${stateName}" renders text-${textUtility!.token} ${textTokenHex} on ${bgDescription}, ` +
          `calculated contrast ratio ${ratio.toFixed(2)}:1, expected >= 4.5:1`
      ).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe("Import summary value contrast (WCAG 2.2 AA)", () => {
  const tokens = extractCssTokens();
  const tokenNames = Object.keys(tokens);

  for (const [metric, classString] of Object.entries(IMPORT_SUMMARY_VALUE_CLASS_NAMES)) {
    it(`${metric} value text achieves >= 4.5:1 on the card surface`, () => {
      const textUtility = findColorUtility(classString, "text", tokenNames);
      expect(textUtility, `Could not find a text token for ${metric}`).not.toBeNull();

      const ratio = getContrastRatio(tokens[textUtility!.token], tokens.card);
      expect(
        ratio,
        `${metric} text --${textUtility!.token} on card ${tokens.card} is ${ratio.toFixed(2)}:1, expected >= 4.5:1`,
      ).toBeGreaterThanOrEqual(4.5);
    });
  }
});

/**
 * Resolves the rendered text/background pair a class string actually paints and asserts the
 * composited ratio. Shared by the project-detail and media-preview surface guards below.
 */
function expectComposedContrast(
  classString: string,
  tokens: Record<string, string>,
  underlyingToken: string,
  label: string
) {
  const tokenNames = Object.keys(tokens);
  const textUtility = findColorUtility(classString, "text", tokenNames);
  expect(textUtility, `Could not find a text-<token> utility for "${label}" in "${classString}"`).not.toBeNull();

  const textTokenHex = tokens[textUtility!.token];
  expect(textTokenHex, `Missing token: --${textUtility!.token}`).toBeDefined();

  const underlyingHex = tokens[underlyingToken];
  const bgUtility = findColorUtility(classString, "bg", tokenNames);
  let renderedBgHex = underlyingHex;
  let bgDescription = `inherited surface --${underlyingToken} ${underlyingHex}`;

  if (bgUtility) {
    const bgTokenHex = tokens[bgUtility.token];
    expect(bgTokenHex, `Missing token: --${bgUtility.token}`).toBeDefined();
    const alpha = bgUtility.opacityPercent !== null ? bgUtility.opacityPercent / 100 : 1;
    renderedBgHex = alpha < 1 ? compositeOverBackground(bgTokenHex, alpha, underlyingHex) : bgTokenHex;
    bgDescription =
      `bg-${bgUtility.token}${bgUtility.opacityPercent !== null ? `/${bgUtility.opacityPercent}` : ""} ` +
      `(${bgTokenHex} at alpha ${alpha}) composited over ${underlyingHex} = ${renderedBgHex}`;
  }

  const ratio = getContrastRatio(renderedBgHex, textTokenHex);
  expect(
    ratio,
    `"${label}" renders text-${textUtility!.token} ${textTokenHex} on ${bgDescription}, ` +
      `calculated contrast ratio ${ratio.toFixed(2)}:1, expected >= 4.5:1`
  ).toBeGreaterThanOrEqual(4.5);
}

describe("Project detail semantic surface rendered contrast (WCAG 2.2 AA)", () => {
  const tokens = extractCssTokens();

  // Regression guarded here: a semantic foreground on a same-hue 10%-opacity semantic
  // background composites to roughly 4.1-4.4:1 on the card surface, below the 4.5:1 floor.
  // These surfaces therefore carry `text-foreground`/`*-strong` and keep the hue on the
  // decorative icon and border only.
  const surfaceStates = Object.keys(PROJECT_DETAIL_SURFACE_CLASSES) as Array<
    keyof typeof PROJECT_DETAIL_SURFACE_CLASSES
  >;

  for (const stateName of surfaceStates) {
    it(`project-detail "${stateName}" surface achieves >= 4.5:1 on its actual rendered background`, () => {
      expectComposedContrast(
        PROJECT_DETAIL_SURFACE_CLASSES[stateName],
        tokens,
        PROJECT_DETAIL_SURFACE_TOKEN,
        `project-detail ${stateName} surface`
      );
    });
  }

  const pageTextRoles = Object.keys(PROJECT_DETAIL_PAGE_TEXT_CLASSES) as Array<
    keyof typeof PROJECT_DETAIL_PAGE_TEXT_CLASSES
  >;

  for (const roleName of pageTextRoles) {
    it(`project-detail "${roleName}" page text achieves >= 4.5:1 on the page background`, () => {
      expectComposedContrast(
        PROJECT_DETAIL_PAGE_TEXT_CLASSES[roleName],
        tokens,
        PROJECT_DETAIL_PAGE_SURFACE_TOKEN,
        `project-detail ${roleName} page text`
      );
    });
  }
});

describe("Admin media preview rendered contrast (WCAG 2.2 AA)", () => {
  const tokens = extractCssTokens();

  for (const stateName of ["assetLabel", "stateMessage", "blockingState"] as const) {
    it(`media preview "${stateName}" achieves >= 4.5:1 on its actual rendered background`, () => {
      expectComposedContrast(
        MEDIA_PREVIEW_CLASSES[stateName],
        tokens,
        MEDIA_PREVIEW_SURFACE_TOKEN,
        `media preview ${stateName}`
      );
    });
  }
});

describe("Review-action rendered contrast (WCAG 2.2 AA)", () => {
  const tokens = extractCssTokens();
  const tokenNames = Object.keys(tokens);

  function renderedActionClasses(action: keyof typeof REVIEW_ACTION_PRESENTATIONS) {
    const presentation = REVIEW_ACTION_PRESENTATIONS[action];
    return buttonVariants({
      variant: presentation.variant,
      size: "default",
      className: presentation.className,
    });
  }

  function expectActionTextContrast(
    action: keyof typeof REVIEW_ACTION_PRESENTATIONS,
    statePrefix = ""
  ) {
    const classString = renderedActionClasses(action);
    const background = findLastColorUtility(classString, "bg", tokenNames, statePrefix);
    const foreground = findLastColorUtility(classString, "text", tokenNames, statePrefix);
    expect(background, `Missing ${statePrefix || "normal"} background for ${action}`).not.toBeNull();
    expect(foreground, `Missing ${statePrefix || "normal"} foreground for ${action}`).not.toBeNull();

    const renderedBackground = renderedBackgroundHex(background!, tokens, tokens.card);
    const ratio = getContrastRatio(tokens[foreground!.token], renderedBackground);
    expect(
      ratio,
      `${action} ${statePrefix || "normal"} text --${foreground!.token} on ${renderedBackground} is ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(4.5);
  }

  it("keeps approve and archive action text at >= 4.5:1", () => {
    expectActionTextContrast("approve");
    expectActionTextContrast("archive");
  });

  it("keeps request changes text at >= 4.5:1 in normal and hover states", () => {
    expectActionTextContrast("request_changes");
    expectActionTextContrast("request_changes", "hover");
  });

  it("keeps the request-changes boundary at >= 3:1 against the card surface", () => {
    const requestChanges = renderedActionClasses("request_changes");
    const border = findLastColorUtility(requestChanges, "border", tokenNames);
    expect(border, "Missing request-changes boundary").not.toBeNull();
    const ratio = getContrastRatio(tokens[border!.token], tokens.card);
    expect(
      ratio,
      `request_changes border --${border!.token} against card is ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(3);
  });
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
