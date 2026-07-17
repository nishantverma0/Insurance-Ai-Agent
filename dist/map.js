import { resolveOption } from "./format.js";
import { normLabel, tokenOverlapScore } from "./text.js";
// -------------------- Confidence --------------------
const HEURISTIC_EXACT_CONF = 0.97;
const HEURISTIC_FUZZY_CONF = 0.82;
const HEURISTIC_FUZZY_MIN_OVERLAP = 0.75;
const MIN_CONFIDENCE_TO_ACT = 0.4;
const LOW_CONFIDENCE_REVIEW_BAR = 0.6;
const CERTIFICATION_WORDS = /certif|acknowledg|attest|confirm.*(accurate|true|complete)|agree/i;
// -------------------- Aliases --------------------
const ALIASES = {
    "name of insured": "BusinessLegalName",
    "insured": "BusinessLegalName",
    "legal name": "BusinessLegalName",
    "doing business as": "DBAName",
    "dba": "DBAName",
    "federal tax id": "FEIN",
    "tax id": "FEIN",
    "fein": "FEIN",
    "organization type": "EntityType",
    "entity type": "EntityType",
    "nature of business": "BusinessDescription",
    "business operations": "BusinessDescription",
    "operations": "BusinessDescription",
    "address line 1": "MailingStreet",
    "city": "MailingCity",
    "state": "MailingState",
    "postal code": "MailingZip",
    "zip": "MailingZip",
    "contact person": "ContactPerson",
    "telephone": "ContactPhone",
    "phone": "ContactPhone",
    "contact e mail": "ContactEmail",
    "contact email": "ContactEmail",
    // Workers Compensation
    "workers compensation insurance": "PriorWcCoverage",
    "workers' compensation insurance": "PriorWcCoverage",
    "workers compensation": "PriorWcCoverage",
    "had workers compensation insurance": "PriorWcCoverage",
    "had workers' compensation insurance": "PriorWcCoverage",
    "wc coverage": "PriorWcCoverage",
    // Carrier
    "expiring carrier": "CurrentTermCarrier",
    "current carrier": "CurrentTermCarrier",
    // Subcontractors
    "use subcontractors": "UsesSubcontractors",
    "uses subcontractors": "UsesSubcontractors",
    "subcontractors": "UsesSubcontractors",
};
// -------------------- Catalog --------------------
export function buildAnswerCatalog(answers) {
    return Object.entries(answers).map(([key, entry]) => {
        const isArray = Array.isArray(entry.answer);
        if (isArray) {
            const items = entry.answer;
            const itemKeys = items.length > 0
                ? Object.keys(items[0])
                : [];
            return {
                key,
                isArray: true,
                arrayItemKeys: itemKeys,
                preview: `array of ${items.length} item(s) with fields: ${itemKeys.join(", ")}`,
            };
        }
        return {
            key,
            isArray: false,
            preview: String(entry.answer),
        };
    });
}
// -------------------- Main --------------------
export async function mapPage({ perception, answers, llm, usedKeys, }) {
    const scalarCatalog = buildAnswerCatalog(answers).filter(c => !c.isArray && !usedKeys.has(c.key));
    const candidateFields = perception.fields.filter(f => f.visible && !f.repeat);
    const heuristicResults = [];
    const needsLlm = [];
    const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // A plain label.includes(k) check lets a short alias key match as a
    // substring of an unrelated word -- e.g. the "state" alias (-> MailingState)
    // matching inside "stateMENTS", or "zip" matching inside a longer token.
    // Both label and the alias keys are already normLabel'd/plain lowercase
    // space-separated text, so anchoring the match to word/phrase boundaries
    // (start-of-string or whitespace on both sides) is sufficient and cheap.
    const hasAliasPhrase = (haystack, phrase) => new RegExp(`(^|\\s)${escapeRegex(phrase)}(\\s|$)`).test(haystack);
    for (const field of candidateFields) {
        const label = normLabel(field.label);
        // ---------- Alias ----------
        const alias = Object.entries(ALIASES).find(([k]) => hasAliasPhrase(label, k));
        if (alias) {
            heuristicResults.push(mkMapping(field, alias[1], 1, `Alias match (${alias[0]})`, "heuristic"));
            continue;
        }
        // ---------- Heuristic ----------
        let best = null;
        for (const entry of scalarCatalog) {
            const exact = normLabel(field.label) ===
                normLabel(entry.key);
            const score = Math.max(tokenOverlapScore(field.label, entry.key), tokenOverlapScore(normLabel(field.label), normLabel(entry.key)));
            if (exact) {
                best = {
                    key: entry.key,
                    score: 1,
                    exact: true,
                };
                break;
            }
            if (!best || score > best.score) {
                best = {
                    key: entry.key,
                    score,
                    exact: false,
                };
            }
        }
        if (best?.exact) {
            heuristicResults.push(mkMapping(field, best.key, HEURISTIC_EXACT_CONF, "Exact label/key match", "heuristic"));
            continue;
        }
        if (best &&
            best.score >= HEURISTIC_FUZZY_MIN_OVERLAP) {
            heuristicResults.push(mkMapping(field, best.key, HEURISTIC_FUZZY_CONF, `Token overlap ${best.score.toFixed(2)}`, "heuristic"));
            continue;
        }
        // ---------- Needs LLM ----------
        needsLlm.push(field);
    }
    // -------------------- LLM --------------------
    let llmResults = [];
    if (needsLlm.length > 0) {
        const llmCatalog = buildAnswerCatalog(answers).filter(c => !usedKeys.has(c.key));
        const raw = await llm.mapFields(needsLlm, llmCatalog);
        llmResults = raw.map(r => {
            const field = needsLlm.find(f => f.refId === r.refId);
            return mkMapping(field, r.answerKey, r.confidence, r.reason, "llm");
        });
    }
    const all = [
        ...heuristicResults,
        ...llmResults,
    ];
    // -------------------- Finalization --------------------
    const finalized = [];
    const claimedKeys = new Set();
    for (const m of all) {
        const field = candidateFields.find(f => f.refId === m.refId);
        // -------------------- Valid mapping --------------------
        if (m.answerKey &&
            m.confidence >= MIN_CONFIDENCE_TO_ACT) {
            if (claimedKeys.has(m.answerKey)) {
                finalized.push({
                    ...m,
                    action: "flag",
                    reason: `answer key "${m.answerKey}" was already mapped to another field on this page (ambiguous duplicate)`
                });
                continue;
            }
            claimedKeys.add(m.answerKey);
            const rawValue = answers[m.answerKey]?.answer ?? "";
            // ---------- Select ----------
            if (field.kind === "select") {
                const resolved = resolveOption(rawValue, field.options || []);
                if (!resolved) {
                    finalized.push({
                        ...m,
                        action: "flag",
                        reason: `answer value "${rawValue}" did not match any available option`
                    });
                    continue;
                }
                finalized.push({
                    ...m,
                    action: "select",
                    chosenOptionValue: resolved.value,
                    confidence: Math.min(m.confidence, resolved.confidence),
                    reason: `${m.reason}; option resolution: ${resolved.reason}`
                });
                continue;
            }
            // ---------- Radio ----------
            if (field.kind === "radio-group") {
                const resolved = resolveOption(rawValue, field.options || []);
                if (!resolved) {
                    finalized.push({
                        ...m,
                        action: "flag",
                        reason: `answer value "${rawValue}" did not match any available option`
                    });
                    continue;
                }
                finalized.push({
                    ...m,
                    action: "check",
                    chosenOptionValue: resolved.value,
                    confidence: Math.min(m.confidence, resolved.confidence),
                    reason: `${m.reason}; option resolution: ${resolved.reason}`
                });
                continue;
            }
            // ---------- Checkbox ----------
            if (field.kind === "checkbox") {
                const truthy = /^(y|yes|true|1)$/i.test(String(rawValue));
                finalized.push({
                    ...m,
                    action: truthy
                        ? "check"
                        : "uncheck"
                });
                continue;
            }
            // ---------- Text ----------
            finalized.push({
                ...m,
                action: "fill"
            });
            continue;
        } // -------------------- Missing answer policy --------------------
        if (field.kind === "checkbox" &&
            field.required &&
            CERTIFICATION_WORDS.test(field.label)) {
            finalized.push({
                refId: field.refId,
                answerKey: null,
                confidence: 1,
                action: "check",
                source: "heuristic",
                reason: "Required certification checkbox automatically checked."
            });
            continue;
        }
        const label = normLabel(field.label);
        // ---------- Generic date fallback ----------
        if (/effective|inception|start/.test(label) &&
            /date/.test(label)) {
            finalized.push({
                refId: field.refId,
                answerKey: "__TODAY__",
                confidence: 1,
                action: "fill",
                source: "heuristic",
                reason: "Generic required effective date."
            });
            continue;
        }
        // ---------- Claims fallback ----------
        if (/claim|loss/.test(label)) {
            finalized.push({
                refId: field.refId,
                answerKey: "__ZERO__",
                confidence: 1,
                action: "fill",
                source: "heuristic",
                reason: "Generic claims fallback."
            });
            continue;
        }
        // ---------- Required ----------
        if (field.required) {
            finalized.push({
                refId: field.refId,
                answerKey: m.answerKey,
                confidence: m.confidence,
                action: "flag",
                source: m.source,
                reason: `Policy: flag-for-human-review. Required field with no confident answermap match. ${m.reason}`
            });
            continue;
        }
        // ---------- Optional ----------
        finalized.push({
            refId: field.refId,
            answerKey: m.answerKey,
            confidence: m.confidence,
            action: "skip",
            source: m.source,
            reason: `Policy: skip. Optional field with no confident answermap match. ${m.reason}`
        });
    }
    return finalized;
}
// ------------------------------------------------------------
function mkMapping(field, answerKey, confidence, reason, source) {
    return {
        refId: field.refId,
        answerKey,
        confidence,
        action: "skip",
        source,
        reason,
    };
}
export const POLICY_THRESHOLDS = {
    MIN_CONFIDENCE_TO_ACT,
    LOW_CONFIDENCE_REVIEW_BAR,
    HEURISTIC_FUZZY_MIN_OVERLAP,
};
