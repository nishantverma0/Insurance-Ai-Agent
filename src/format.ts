import type { PerceivedField } from "./types.js";

/**
 * Reformats a raw answermap value to match what a given field appears to
 * expect, based only on generic signals present on the field itself
 * (input type, placeholder, helper text, pattern). No knowledge of any
 * specific form is used here.
 */
export function formatValueForField(raw: unknown, field: PerceivedField): string {
  let value = String(raw ?? "").trim();
  const hints = `${field.placeholder || ""} ${field.helperText || ""} ${field.pattern || ""}`.toLowerCase();

  // --- phone numbers ------------------------------------------------------
  if (field.kind === "tel" || /phone|tel(ephone)?/.test(field.label.toLowerCase())) {
    const digits = value.replace(/\D/g, "");
    if (/digits?\s*only|no\s*dashes|no\s*parentheses|no\s*spaces/.test(hints)) {
      return digits;
    }
    if (digits.length === 10) {
      // default to a human formatted US number unless the field clearly wants raw digits
      if (/\(\d{3}\)/.test(field.placeholder || "") || field.placeholder?.includes("(")) {
        return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
      }
    }
    return digits.length >= 10 ? digits : value;
  }

  // --- dates ---------------------------------------------------------------
  if (field.kind === "date" || /date/.test(field.label.toLowerCase())) {
    const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (field.kind === "date") {
      // native <input type=date> always wants ISO yyyy-mm-dd regardless of visual placeholder
      if (iso) return value;
      const mdY = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (mdY) return `${mdY[3]}-${mdY[1].padStart(2, "0")}-${mdY[2].padStart(2, "0")}`;
      return value;
    }
    // free-text date field: honor an explicit MM/DD/YYYY-style hint
    if (/mm\s*\/\s*dd\s*\/\s*yyyy/.test(hints) && iso) {
      return `${iso[2]}/${iso[3]}/${iso[1]}`;
    }
    if (/dd\s*\/\s*mm\s*\/\s*yyyy/.test(hints) && iso) {
      return `${iso[3]}/${iso[2]}/${iso[1]}`;
    }
    return value;
  }

  // --- currency / numbers ---------------------------------------------------
  if (field.kind === "number" || /payroll|premium|\$/.test(field.label.toLowerCase())) {
    const cleaned = value.replace(/[^0-9.\-]/g, "");
    return cleaned || value;
  }

  // --- EIN / tax id style patterns (XX-XXXXXXX) ------------------------------
  if (/xx-xxxxxxx|tax\s*id|ein|federal\s*id/.test(hints) || /tax id|ein|employer identification/.test(field.label.toLowerCase())) {
    const digits = value.replace(/\D/g, "");
    if (digits.length === 9) return `${digits.slice(0, 2)}-${digits.slice(2)}`;
    return value;
  }

  return value;
}

/**
 * Best-effort option resolver: match an answermap value against a list of
 * select/radio options using normalized exact match, then substring /
 * token-overlap fuzzy match. Returns the option `value` to select, or null
 * if nothing crosses a reasonable confidence bar.
 */
export function resolveOption(
  raw: unknown,
  options: { value: string; text: string }[]
): { value: string; confidence: number; reason: string } | null {
  const target = String(raw ?? "").trim().toLowerCase();
  if (!target) return null;

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const targetN = norm(target);

  // 1. exact match on value or text
  for (const o of options) {
    if (o.value.toLowerCase() === target || o.text.toLowerCase() === target) {
      return { value: o.value, confidence: 1, reason: "exact match" };
    }
  }

  // 2. normalized exact match
  for (const o of options) {
    if (norm(o.value) === targetN || norm(o.text) === targetN) {
      return { value: o.value, confidence: 0.95, reason: "normalized exact match" };
    }
  }

  // 3. abbreviation expansion: does the option text start with, or contain
  //    as a whole word, every letter-token of the target acronym, e.g.
  //    target "LLC" vs option "Limited Liability Company" (first letters)
  for (const o of options) {
    const words = norm(o.text).split(" ").filter(Boolean);
    const initials = words.map((w) => w[0]).join("");
    if (initials === targetN.replace(/\s+/g, "")) {
      return { value: o.value, confidence: 0.9, reason: `acronym match against "${o.text}"` };
    }
  }

  // 4. substring / token overlap fuzzy match
  let best: { o: (typeof options)[number]; score: number } | null = null;
  for (const o of options) {
    const optN = norm(o.text);
    let score = 0;
    if (optN.includes(targetN) || targetN.includes(optN)) score = 0.7;
    else {
      const tTokens = new Set(targetN.split(" "));
      const oTokens = new Set(optN.split(" "));
      const overlap = [...tTokens].filter((t) => oTokens.has(t)).length;
      score = overlap / Math.max(tTokens.size, oTokens.size, 1);
    }
    if (!best || score > best.score) best = { o, score };
  }
  if (best && best.score >= 0.5) {
    return { value: best.o.value, confidence: Math.min(0.85, 0.5 + best.score / 2), reason: `fuzzy match against "${best.o.text}" (score ${best.score.toFixed(2)})` };
  }

  return null;
}
