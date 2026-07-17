import type { Page } from "playwright";
import type { AnswerMap, FieldMapping, PerceivedField, RepeatGroup } from "./types.js";
import type { AnswerCatalogEntry, LlmClient } from "./llm.js";
import { formatValueForField } from "./format.js";
import { normLabel } from "./text.js";

const refLocator = (page: Page, refId: string) =>
    page.locator(`[data-agent-ref="${refId}"]`).first();

export async function applyMapping(
  page: Page,
  field: PerceivedField,
  mapping: FieldMapping,
  answers: AnswerMap
): Promise<void> {

  if (mapping.action === "skip" || mapping.action === "flag") {
    return;
  }
  const locator = refLocator(page, field.refId);

  await locator.waitFor({
      state: "attached",
      timeout: 5000
  });

  await locator.scrollIntoViewIfNeeded();

  let raw: string | number | boolean = "";

  // ---------- Special fallback values ----------
  if (mapping.answerKey === "__TODAY__") {
    raw = new Date().toISOString().slice(0, 10);
  }

  else if (mapping.answerKey === "__ZERO__") {
    raw = 0;
  }

  else if (mapping.answerKey) {

    // Array item support (ClassCodes.code etc.)
    if (mapping.answerKey.includes(".")) {

        const [arrayKey, itemKey] = mapping.answerKey.split(".");

        const row =
            field.repeat?.rowIndex ?? 0;

        const arr =
            answers[arrayKey]?.answer;

        if (Array.isArray(arr)) {

            raw =
                arr[row]?.[itemKey];

        }

    } else {

        raw =
            answers[mapping.answerKey]?.answer as
                | string
                | number
                | boolean;

    }
  }

  switch (mapping.action) {

    case "fill": {
    const value = formatValueForField(raw, field);

    const locator = refLocator(page, field.refId);

    await locator.waitFor({
        state: "visible",
        timeout: 5000
    });

    const readonly = await locator.evaluate(el =>
        (el as HTMLInputElement).readOnly
    );

    if (readonly) {
        return;
    }

    await locator.scrollIntoViewIfNeeded();

    // Native <input type="date"> exposes segmented month/day/year controls,
    // not a plain text buffer -- clicking + Ctrl/Cmd+A + Delete + typing the
    // ISO string character-by-character (including the "-" separators) gets
    // distributed across those segments in the wrong order and produces
    // garbage (e.g. "2026-08-01" typed in landed as "60801-02-20").
    // Playwright's locator.fill() sets a date input's value directly in
    // "YYYY-MM-DD" form without simulating keystrokes, so use that path
    // instead for this field kind.
    if (field.kind === "date") {

        await locator.fill(value);

        await locator.evaluate((el) => {
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            (el as HTMLElement).blur();
        });

        await page.waitForTimeout(100);

        const actualDate = await locator.inputValue();

        if (actualDate !== value) {
            throw new Error(
                `Failed filling "${field.label}" expected "${value}" got "${actualDate}"`
            );
        }

        break;
    }

    await locator.click();

    const modifier =
    (globalThis as any).process?.platform === "darwin"
      ? "Meta"
      : "Control";

    await locator.press(`${modifier}+A`);

    await locator.press("Delete");

    await locator.type(value, {
        delay: 20
    });

    await locator.evaluate((el) => {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        (el as HTMLElement).blur();
    });

    await page.waitForTimeout(100);

    let actual = await locator.inputValue();

    const normalize = (s: string) =>
        s.replace(/[\s(),-]/g, "");

    if (normalize(actual) !== normalize(value)) {

        if (
            (field.kind as string) === "combobox" ||
            (field.kind as string) === "autocomplete"
        ) {
            await locator.press("ArrowDown").catch(() => {});
            await locator.press("Enter").catch(() => {});
        }
        await page.waitForTimeout(300);

        actual = await locator.inputValue();

        if (normalize(actual) !== normalize(value)) {
            throw new Error(
                `Failed filling "${field.label}" expected "${value}" got "${actual}"`
            );
        }
    }

    break;
}

    case "select": {

    const locator = refLocator(page, field.refId);

    await locator.selectOption({
        value: mapping.chosenOptionValue!
    });

    const selected = await locator.inputValue();

    if (selected !== mapping.chosenOptionValue) {
        throw new Error(
            `${field.label} select failed`
        );
    }

    break;
}

    case "check": {

    const locator = refLocator(page, field.refId);

    if (field.kind === "radio-group") {

    const radio = page.locator(
        `input[type="radio"][data-agent-ref="${field.refId}"]`
    );

    const count = await radio.count();

    // map.ts already resolved which option to pick (handling cases like
    // answer text "Yes" vs a terse DOM value="Y") and put it in
    // chosenOptionValue. Fall back to the raw answer only for callers
    // that don't go through that resolution path (e.g. repeat rows).
    const target = (
        mapping.chosenOptionValue ?? String(raw)
    ).toLowerCase();

    for (let i = 0; i < count; i++) {

        const value = (
            await radio.nth(i).getAttribute("value")
        ) ?? "";

        if (value.toLowerCase() === target) {

            await radio.nth(i).check();

            return;
        }

    }

    throw new Error(
        `No radio option matched "${mapping.chosenOptionValue ?? raw}"`
    );
}

    // Plain checkbox: actually check it -- previously this only read
    // isChecked() and never clicked, so a mapping decision of "check"
    // never changed anything on the page.
    if (!(await locator.isChecked())) {
        await locator.check();
    }

    if (!(await locator.isChecked())) {
        throw new Error(
            `${field.label} checkbox failed`
        );
    }

    break;
}

    case "uncheck": {

      await refLocator(page, field.refId)
        .first()
        .uncheck();

      break;
    }
  }
}

/**
 * Matches a repeating section (e.g. "class code" rows) against the
 * best-fitting array-valued answermap key using generic label/key-name
 * token overlap -- no knowledge of specific field names is used.
 */
export function matchArrayAnswerKey(group: RepeatGroup, catalog: AnswerCatalogEntry[]): AnswerCatalogEntry | null {
  const rowBlob = normLabel(group.rowFieldLabels.join(" "));
  const rowTokens = new Set(rowBlob.split(" ").filter((t) => t.length > 2));

  let best: { entry: AnswerCatalogEntry; score: number } | null = null;
  for (const entry of catalog.filter((c) => c.isArray)) {
    const keyBlob = normLabel([entry.key, ...(entry.arrayItemKeys || [])].join(" "));
    const keyTokens = new Set(keyBlob.split(" ").filter((t) => t.length > 2));
    const overlap = [...rowTokens].filter((t) => keyTokens.has(t)).length;
    const score = overlap / Math.max(rowTokens.size, 1);
    if (!best || score > best.score) best = { entry, score };
  }
  return best && best.score > 0 ? best.entry : null;
}

/**
 * Determines, for one "template" row (row index 0), which item-object key
 * each field slot corresponds to. Because every row in a detected repeat
 * group is structurally identical, this single mapping is then reused
 * positionally across all rows -- so the LLM/heuristic cost is paid once
 * per repeating section, not once per row.
 */
export async function mapRepeatRowTemplate(
  templateFields: PerceivedField[],
  itemKeys: string[],
  llm: LlmClient
): Promise<(string | null)[]> {
  const pseudoCatalog: AnswerCatalogEntry[] = itemKeys.map((k) => ({ key: k, isArray: false, preview: k }));

  const results: (string | null)[] = [];
  const needsLlm: { idx: number; field: PerceivedField }[] = [];

  const manualMap: Record<string, string> = {
    "code": "code",
    "classification description": "description",
    "description": "description",
    "# emp": "employees",
    "emp": "employees",
    "employee": "employees",
    "employees": "employees",
    "est annual payroll": "annualPayroll",
    "annual payroll": "annualPayroll",
    "payroll": "annualPayroll",
  };

  templateFields.forEach((f, idx) => {

    const label = normLabel(f.label);

    for (const [k, v] of Object.entries(manualMap)) {
      if (label.includes(k)) {
        results[idx] = v;
        return;
      }
    }

    const aliases: Record<string, string> = {

        "code": "code",
        "class code": "code",

        "classification description": "description",
        "description": "description",

        "# emp": "employees",
        "emp": "employees",
        "employee": "employees",
        "employees": "employees",

        "payroll": "annualPayroll",
        "annual payroll": "annualPayroll"
    };

    const alias = Object.entries(aliases)
        .find(([k]) => label.includes(k));

    if (alias) {

        results[idx] = alias[1];

        return;
    }

    let best: null | { key: string; score: number } = null;

    for (const k of itemKeys) {

        const score =
            label.includes(normLabel(k))
            ? 1
            : 0;

        if (!best || score > best.score) {
            best = { key: k, score };
        }
    }

    if (best && best.score > 0) {

        results[idx] = best.key;

    } else {

        results[idx] = null;

        needsLlm.push({
            idx,
            field: f
        });

    }

  });

  if (needsLlm.length > 0) {
    const raw = await llm.mapFields(
      needsLlm.map((n) => n.field),
      pseudoCatalog
    );
    for (const r of raw) {
      const hit = needsLlm.find((n) => n.field.refId === r.refId);
      if (hit && r.answerKey) results[hit.idx] = r.answerKey;
    }
  }

  return results;
}