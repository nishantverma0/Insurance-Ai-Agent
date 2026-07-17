import { chromium } from "playwright";
import { perceivePage } from "./perceive.js";
import { mapPage, buildAnswerCatalog, POLICY_THRESHOLDS } from "./map.js";
import { applyMapping, matchArrayAnswerKey, mapRepeatRowTemplate } from "./fill.js";
import { clickAddRow, clickButton, checkOutcome, pickAdvanceButton, getVisibleFieldSignature } from "./navigate.js";
const MAX_PAGES = 12;
const MAX_ATTEMPTS_PER_PAGE = 3;
const MAX_CONDITIONAL_RESCANS = 4;
function fieldIdentity(f) {
    return `${f.kind}::${f.label}`;
}
export async function runAgent({ formPath, answers, llm, headless = true }) {
    const startedAt = new Date().toISOString();
    const decisionLog = [];
    const fieldsFlagged = [];
    const usedKeys = new Set();
    const browser = await chromium.launch({ headless });
    const page = await browser.newPage();
    const target = /^https?:\/\//.test(formPath) ? formPath : `file://${formPath}`;
    await page.goto(target);
    let outcome = "error";
    let reason;
    let confirmationData = null;
    let pagesVisited = 0;
    let fieldsFilled = 0;
    const log = (entry) => decisionLog.push({ timestamp: new Date().toISOString(), ...entry });
    try {
        for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
            pagesVisited++;
            let perception = await perceivePage(page, pageIndex);
            // --- 1. repeating sections -------------------------------------------------
            for (const group of perception.repeatGroups) {
                const catalog = buildAnswerCatalog(answers);
                const matchedEntry = matchArrayAnswerKey(group, catalog);
                if (!matchedEntry || !matchedEntry.arrayItemKeys) {
                    log({
                        pageIndex,
                        refId: group.groupRefId,
                        label: `repeating section (${group.rowFieldLabels.join(", ")})`,
                        candidateAnswerKey: null,
                        confidence: null,
                        reasoning: "No array-valued answermap key matched this repeating section's row shape.",
                        action: "add-row",
                        detail: "skipped",
                    });
                    continue;
                }
                const items = matchedEntry.arrayItemKeys ? (answers[matchedEntry.key].answer ?? []) : [];
                const rowsToAdd = Math.max(0, items.length - group.currentRowCount);
                if (rowsToAdd > 0 && !group.addButtonRefId) {
                    log({
                        pageIndex,
                        refId: group.groupRefId,
                        label: `repeating section (${group.rowFieldLabels.join(", ")})`,
                        candidateAnswerKey: matchedEntry.key,
                        confidence: 0.9,
                        reasoning: `Matched to array answer key "${matchedEntry.key}" but its "add row" button could not be resolved to an element (likely hidden at perception time). Skipping row addition to avoid clicking an unresolvable reference.`,
                        action: "add-row",
                        detail: "skipped",
                    });
                }
                else if (rowsToAdd > 0) {
                    await clickAddRow(page, group.addButtonRefId, rowsToAdd);
                }
                log({
                    pageIndex,
                    refId: group.groupRefId,
                    label: `repeating section (${group.rowFieldLabels.join(", ")})`,
                    candidateAnswerKey: matchedEntry.key,
                    confidence: 0.9,
                    reasoning: `Matched repeating section to array answer key "${matchedEntry.key}"; added ${rowsToAdd} row(s) to reach ${items.length} total.`,
                    action: "add-row",
                });
                // re-perceive to get refs for the (possibly new) rows, then fill by position
                perception = await perceivePage(page, pageIndex);
                const liveGroup = perception.repeatGroups.find(g => JSON.stringify(g.rowFieldLabels) === JSON.stringify(group.rowFieldLabels));
                if (!liveGroup) {
                    throw new Error("Repeat group disappeared after adding rows.");
                }
                const rowGroups = {};
                perception.fields
                    .filter(f => f.repeat &&
                    JSON.stringify(perception.repeatGroups.find(g => g.groupRefId === f.repeat.groupRefId)?.rowFieldLabels) === JSON.stringify(group.rowFieldLabels))
                    .forEach(f => {
                    const idx = f.repeat.rowIndex;
                    if (!rowGroups[idx])
                        rowGroups[idx] = [];
                    rowGroups[idx].push(f);
                });
                const templateFields = rowGroups[0] || [];
                if (templateFields.length === 0) {
                    throw new Error("Repeat group detected but row 0 contains no fields.");
                }
                const positionToItemKey = await mapRepeatRowTemplate(templateFields, matchedEntry.arrayItemKeys, llm);
                for (let rowIdx = 0; rowIdx < items.length; rowIdx++) {
                    const rowFields = rowGroups[rowIdx] || [];
                    rowFields.sort((a, b) => templateFields.findIndex(t => t.label === a.label) -
                        templateFields.findIndex(t => t.label === b.label));
                    const item = items[rowIdx];
                    for (let pos = 0; pos < rowFields.length; pos++) {
                        const itemKey = positionToItemKey[pos];
                        const field = rowFields[pos];
                        if (!itemKey || !(itemKey in item)) {
                            fieldsFlagged.push({ pageIndex, refId: field.refId, label: `${field.label} (row ${rowIdx + 1})`, reason: "no matching item field for this row slot" });
                            log({ pageIndex, refId: field.refId, label: field.label, candidateAnswerKey: null, confidence: null, reasoning: "row slot had no confident item-key match", action: "flag" });
                            continue;
                        }
                        try {
                            await applyMapping(page, field, {
                                refId: field.refId,
                                answerKey: `${matchedEntry.key}.${itemKey}`,
                                confidence: 0.8,
                                reason: "repeat-row positional match",
                                action: "fill",
                                source: "heuristic"
                            }, answers);
                        }
                        catch (e) {
                            console.error("Error applying mapping:", e);
                            fieldsFlagged.push({ pageIndex, refId: field.refId, label: `${field.label} (row ${rowIdx + 1})`, reason: `failed to apply mapping for item key "${itemKey}": ${e}` });
                            log({ pageIndex, refId: field.refId, label: field.label, candidateAnswerKey: itemKey, confidence: 0.8, reasoning: `failed to apply mapping for item key "${itemKey}": ${e}`, action: "flag" });
                            continue;
                        }
                        fieldsFilled++;
                        log({
                            pageIndex,
                            refId: field.refId,
                            label: `${field.label} (row ${rowIdx + 1})`,
                            candidateAnswerKey: `${matchedEntry.key}[${rowIdx}].${itemKey}`,
                            confidence: 0.8,
                            reasoning: "positional template match reused across all rows in the repeating section",
                            action: "fill",
                        });
                    }
                }
            }
            // --- 2. top-level fields, with conditional re-scans -------------------------
            const processed = new Set();
            perception = await perceivePage(page, pageIndex);
            for (let rescan = 0; rescan < MAX_CONDITIONAL_RESCANS; rescan++) {
                const candidates = perception.fields.filter(f => f.visible && !f.repeat && !processed.has(fieldIdentity(f)));
                if (candidates.length === 0) {
                    break;
                }
                const subPerception = {
                    ...perception,
                    fields: candidates
                };
                const mappings = await mapPage({
                    perception: subPerception,
                    answers,
                    llm,
                    usedKeys
                });
                let pageChanged = false;
                for (const m of mappings) {
                    const field = candidates.find(f => f.refId === m.refId);
                    if (!field)
                        continue;
                    processed.add(fieldIdentity(field));
                    if (m.answerKey &&
                        (m.action === "fill" ||
                            m.action === "select" ||
                            m.action === "check" ||
                            m.action === "uncheck")) {
                        usedKeys.add(m.answerKey);
                    }
                    let applyError = null;
                    if (m.action === "fill" ||
                        m.action === "select" ||
                        m.action === "check" ||
                        m.action === "uncheck") {
                        try {
                            await applyMapping(page, field, m, answers);
                            fieldsFilled++;
                            pageChanged = true;
                        }
                        catch (e) {
                            applyError = e?.message || String(e);
                        }
                    }
                    if (applyError ||
                        m.action === "flag" ||
                        (m.confidence < POLICY_THRESHOLDS.LOW_CONFIDENCE_REVIEW_BAR &&
                            m.action !== "skip")) {
                        fieldsFlagged.push({
                            pageIndex,
                            refId: field.refId,
                            label: field.label,
                            reason: applyError ? `failed to apply mapping: ${applyError}` : m.reason
                        });
                    }
                    log({
                        pageIndex,
                        refId: field.refId,
                        label: field.label,
                        candidateAnswerKey: m.answerKey,
                        confidence: m.confidence,
                        reasoning: applyError
                            ? `[${m.source}] ${m.reason} -- APPLY FAILED: ${applyError}`
                            : `[${m.source}] ${m.reason}`,
                        action: applyError ? "flag" : m.action
                    });
                }
                if (!pageChanged) {
                    break;
                }
                perception = await perceivePage(page, pageIndex);
            }
            // --- 3. advance the page -----------------------------------------------------
            let advancedOk = false;
            let lastAttemptedLabel = "";
            for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_PAGE; attempt++) {
                // Re-perceive AND re-pick the button on every attempt. Reusing a
                // button reference across retries is unsafe: if the previous click
                // actually succeeded (or partially mutated the DOM) the old ref may
                // now point at a hidden/removed element, which would otherwise hang
                // until Playwright's actionability timeout.
                perception = await perceivePage(page, pageIndex);
                const advanceBtn = pickAdvanceButton(perception.actionButtons);
                if (!advanceBtn) {
                    outcome = "stuck";
                    reason = `No Next/Continue/Submit button found on page ${pageIndex} (attempt ${attempt}).`;
                    break;
                }
                lastAttemptedLabel = advanceBtn.text;
                const sigBefore = await getVisibleFieldSignature(page);
                try {
                    await clickButton(page, advanceBtn.refId);
                }
                catch (clickErr) {
                    log({
                        pageIndex,
                        refId: advanceBtn.refId,
                        label: advanceBtn.text,
                        candidateAnswerKey: null,
                        confidence: null,
                        reasoning: `Attempt ${attempt}/${MAX_ATTEMPTS_PER_PAGE}: click on "${advanceBtn.text}" failed (${clickErr?.message?.split("\n")[0] || clickErr}). Will re-perceive and retry.`,
                        action: "stuck",
                    });
                    continue;
                }
                const check = await checkOutcome(page, sigBefore);
                // If checkOutcome signals a terminal success (confirmation page),
                // mark overall outcome as success and capture any confirmation data.
                if (check.success) {
                    outcome = "success";
                    confirmationData = check.confirmationData ?? null;
                    break;
                }
                if (check.advanced) {
                    advancedOk = true;
                    log({ pageIndex, refId: advanceBtn.refId, label: advanceBtn.text, candidateAnswerKey: null, confidence: null, reasoning: "Visible field set changed after click; treating as advanced to next step.", action: "navigate" });
                    break;
                }
                const errsNow = (await perceivePage(page, pageIndex)).visibleErrors;
                log({
                    pageIndex,
                    refId: advanceBtn.refId,
                    label: advanceBtn.text,
                    candidateAnswerKey: null,
                    confidence: null,
                    reasoning: `Attempt ${attempt}/${MAX_ATTEMPTS_PER_PAGE}: click did not change the visible field set (still on the same step). Visible validation errors: ${errsNow.join(" | ") || "(none found)"}`,
                    action: "stuck",
                });
            }
            if (outcome === "success")
                break;
            if (!advancedOk && outcome !== "stuck") {
                outcome = "stuck";
                reason = `Form did not advance from page ${pageIndex} after ${MAX_ATTEMPTS_PER_PAGE} attempts clicking "${lastAttemptedLabel}". See decision log for validation errors and flagged fields.`;
            }
            if (outcome === "stuck")
                break;
        }
        if (outcome === "error" && pagesVisited >= MAX_PAGES) {
            outcome = "stuck";
            reason = `Exceeded maximum page cap (${MAX_PAGES}) without reaching a confirmation page.`;
        }
    }
    catch (e) {
        outcome = "error";
        reason = e?.message || String(e);
    }
    finally {
        await browser.close();
    }
    return {
        form: formPath,
        startedAt,
        finishedAt: new Date().toISOString(),
        outcome,
        reason,
        pagesVisited,
        fieldsFilled,
        fieldsFlagged,
        confirmationData,
        decisionLog,
    };
}
