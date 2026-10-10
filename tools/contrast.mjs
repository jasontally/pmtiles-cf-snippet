#!/usr/bin/env node
/**
 * Measure a dark palette against the WCAG contrast thresholds.
 *
 *   node tools/contrast-report.mjs dark          # the shipped dark
 *   node tools/contrast-report.mjs dark midnight # compare candidates
 *
 * The two numbers that matter, from WCAG 2.2:
 *
 *   4.5:1  SC 1.4.3 Contrast (Minimum), AA. Text against its background.
 *          3:1 for text at least 18pt, or 14pt bold.
 *   3:1    SC 1.4.11 Non-text Contrast, AA. Graphical objects required to
 *          understand the content: the parts of a map that carry meaning.
 *
 * A map label is text, so 4.5:1. A road is a graphical object, so 3:1. A land
 * fill is the background those two sit on and has no threshold of its own, which
 * is why a dark map can keep its area colours near black without failing
 * anything: the criterion is on the line and the label, not on the ground they
 * cover. That is the shape of a correct dark palette, and it is what the
 * candidates are measured against.
 *
 * The ratio is computed by the formula WCAG specifies, not by eye:
 *   relative luminance L = 0.2126R + 0.7152G + 0.0722B, on linearised channels
 *   contrast = (L_lighter + 0.05) / (L_darker + 0.05)
 */

/** sRGB channel to linear, per the WCAG formula. */
function linearise(channel) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Hex to relative luminance. */
export function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a 6 digit hex: ${hex}`);
  const n = parseInt(m[1], 16);
  return (
    0.2126 * linearise((n >> 16) & 255) +
    0.7152 * linearise((n >> 8) & 255) +
    0.0722 * linearise(n & 255)
  );
}

/** The WCAG contrast ratio between two hex colours. */
export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** How much a luminance is above black, as a percentage. */
export function aboveBlack(hex) {
  return ((luminance(hex) - luminance("#000000")) / (luminance("#ffffff") - luminance("#000000"))) * 100;
}

/** True when a pair clears the bar, with the bar it cleared. */
export function vote(a, b, kind) {
  const ratio = contrast(a, b);
  const bar = kind === "text" ? 4.5 : 3;
  return { ratio, bar, pass: ratio >= bar, kind };
}
