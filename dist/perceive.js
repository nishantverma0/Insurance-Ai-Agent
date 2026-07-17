/**
 * Everything in this function runs inside the browser (page.evaluate). It is
 * intentionally generic: it reasons about tag names, ARIA semantics, CSS
 * visibility, and DOM proximity -- never about specific ids/names/labels
 * belonging to any particular form. This is what lets the exact same code
 * run against a form it has never seen.
 */
async function extractInBrowser() {
    // Refs must be unique to THIS snapshot only. Without this, an element's
    // data-agent-ref from a prior perceivePage() call (e.g. a now-hidden
    // "Continue" button on a step the user already passed) survives in the
    // DOM. Since the ref counter below is deterministic, a different,
    // currently-visible element can end up assigned the exact same ref value
    // -- and `.locator(...).first()` will then resolve to whichever one comes
    // first in the DOM, which may be the stale hidden one.
    document.querySelectorAll("[data-agent-ref]").forEach((el) => el.removeAttribute("data-agent-ref"));
    function isVisible(el) {
        const htmlEl = el;
        // Cheap first-line filter: an element with no layout box at all
        // (display:none on itself or an ancestor, or not attached to the
        // rendered tree) has offsetParent === null. Fixed-position elements
        // are the one legitimate case where offsetParent is null even though
        // the element IS visible, so they're excluded from this check.
        if (htmlEl.offsetParent === null && window.getComputedStyle(htmlEl).position !== "fixed") {
            return false;
        }
        const style = window.getComputedStyle(htmlEl);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")
            return false;
        const rect = htmlEl.getBoundingClientRect();
        // A hidden template/clone row is often collapsed on just ONE axis
        // (e.g. max-height: 0; overflow: hidden, or width: 0), not both. Using
        // `&&` here let such rows read as "visible", which caused them to be
        // picked up as real repeat-group rows and steal field bindings from
        // the actual on-screen row. Must be `||`: either axis collapsing to
        // zero means the element has no visible footprint.
        if (rect.width === 0 || rect.height === 0)
            return false;
        // A template row parked off-screen (e.g. `position: absolute; left:
        // -9999px`, a common pre-CSS-Grid trick for keeping a clone-source
        // node in the layout tree without showing it) has a real, nonzero
        // bounding box and passes every check above. Treat anything entirely
        // outside the document's scrollable area as not visible.
        const docW = document.documentElement.scrollWidth;
        const docH = document.documentElement.scrollHeight;
        if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= docW || rect.top >= docH)
            return false;
        // walk up ancestors for display:none, aria-hidden, or a "hidden"-ish
        // utility class driven by JS toggles. aria-hidden is a common pattern
        // for marking an inert clone-source template block that framework
        // "repeater" widgets (React/Vue/vanilla templating) keep in the DOM.
        let node = el;
        while (node) {
            const s = window.getComputedStyle(node);
            if (s.display === "none" || s.visibility === "hidden")
                return false;
            if (node.getAttribute && node.getAttribute("aria-hidden") === "true")
                return false;
            node = node.parentElement;
        }
        return true;
    }
    function textOf(el) {
        return (el?.textContent || "").replace(/\s+/g, " ").trim();
    }
    function findLabelFor(el) {
        const id = el.id;
        if (id) {
            const forLabel = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (forLabel)
                return textOf(forLabel);
        }
        // wrapping label
        const wrappingLabel = el.closest("label");
        if (wrappingLabel) {
            // strip the text of the input itself (e.g. checkbox has no text) -- fine, label text includes it
            return textOf(wrappingLabel);
        }
        // nearest preceding label-like element within the same fieldset/container
        let node = el;
        for (let hop = 0; hop < 6 && node; hop++) {
            let sib = node.previousElementSibling;
            while (sib) {
                if (sib.tagName === "LABEL" || /^H[1-6]$/.test(sib.tagName)) {
                    const t = textOf(sib);
                    if (t)
                        return t;
                }
                sib = sib.previousElementSibling;
            }
            node = node.parentElement;
        }
        // aria-label / placeholder fallback
        const aria = el.getAttribute("aria-label");
        if (aria)
            return aria;
        return "";
    }
    function findHelperText(el, label) {
        const parts = [];
        const placeholder = el.getAttribute("placeholder");
        if (placeholder)
            parts.push(placeholder);
        // sibling / nested "note"-ish small text near the label
        const container = el.closest("div, fieldset, li") || el.parentElement;
        if (container) {
            const smallEls = container.querySelectorAll("small, .note, .hint, .help, span");
            smallEls.forEach((s) => {
                const t = textOf(s);
                if (t && t.length < 120 && t !== label)
                    parts.push(t);
            });
        }
        // parenthetical hints embedded in the label text itself, e.g. "(MM/DD/YYYY)"
        const paren = label.match(/\(([^)]+)\)/);
        if (paren)
            parts.push(paren[1]);
        return Array.from(new Set(parts)).join(" | ");
    }
    // Many carrier forms mark a field required only by convention -- a
    // trailing "*" in the visible label text -- without ever setting the
    // native HTML `required` attribute (the page's own hand-written JS
    // validates against the DOM value directly, not via the attribute). If we
    // only trust `el.required`, such fields silently get policy-classified as
    // "optional, no match -> skip" instead of "required, no match -> flag",
    // and the page can never validate, leaving the run permanently stuck on
    // whatever step contains that field. This is a generic textual signal
    // (not tied to any one carrier's markup), so it's safe to apply broadly.
    function labelSuggestsRequired(label) {
        return /\*\s*$/.test(label.trim());
    }
    // Attestation/certification controls ("The producer certifies the above
    // statements are true and complete.") are almost always a single required
    // checkbox with a long sentence as its label, not a data-entry field. A
    // generic fill layer that treats every ref the same way (e.g. always
    // calling .fill(value) rather than .check()) will silently fail to toggle
    // these -- the checkbox stays unchecked, currentValue looks "handled" in
    // logs, and the carrier's own JS validator blocks Save & Continue with no
    // error surfaced back to us. Flagging this explicitly lets the fill layer
    // branch on it instead of relying on `kind === "checkbox"` alone (which
    // is already true, but easy to miss/mis-route in a mapper that keys off
    // label text/heuristics for "which value to type").
    function looksLikeAttestation(label) {
        const t = label.toLowerCase();
        return /\bcertif(y|ies|ication)\b/.test(t) || /\backnowledge(s)?\b/.test(t) || /\bagree(s)?\s+that\b/.test(t);
    }
    function kindFor(el) {
        if (el.tagName === "TEXTAREA")
            return "textarea";
        if (el.tagName === "SELECT")
            return "select";
        const t = el.type;
        if (t === "radio")
            return "radio-group";
        if (t === "checkbox")
            return "checkbox";
        if (["email", "tel", "date", "number"].includes(t))
            return t;
        return "text";
    }
    const repeatGroups = [];
    const candidateContainers = new Set();
    document.querySelectorAll("input, select, textarea").forEach((inp) => {
        const row = inp.closest("tr") ||
            inp.closest('[role="row"]') ||
            inp.closest("fieldset") ||
            inp.closest("li") ||
            inp.closest("div");
        if (row && row.parentElement) {
            candidateContainers.add(row.parentElement);
        }
        else if (inp.parentElement) {
            candidateContainers.add(inp.parentElement);
        }
    });
    candidateContainers.forEach((container) => {
        // Only ever consider children that are (a) form-control-bearing and
        // (b) actually rendered. Without the visibility check, a hidden
        // duplicate/legacy mirror block with the same input signature as the
        // real, visible block gets counted as an equally-valid "row". That
        // causes two problems downstream: the hidden block can claim
        // rowIndex 0 ahead of the real block (so real data gets bound to
        // unfillable, zero-size fields), and the real block can get shifted
        // to a row slot the mapper never filled (surfacing as spurious
        // "no matching item field for this row slot" flags).
        const children = Array.from(container.children)
            .filter(c => isVisible(c) &&
            c.querySelector("input,select,textarea"));
        // A single uniform child is just an ordinary wrapper (e.g. a page's only
        // <fieldset>), not a repeating section -- genuine repetition requires at
        // least two structurally-identical siblings.
        if (children.length < 1) {
            return;
        }
        // Search ONLY inside this container for an "add" affordance.
        const addBtn = Array.from(container.querySelectorAll('button,a')).find((b) => isVisible(b) && /\b(add|new|another|\+)\b/i.test(textOf(b))) ?? null;
        if (!addBtn) {
            return;
        }
        // signature = sorted list of input types within a child block
        const sig = (c) => Array.from(c.querySelectorAll("input, select, textarea"))
            .map((n) => n.type || n.tagName)
            .sort()
            .join(",");
        const sigs = children.map(sig);
        const allSame = sigs.length > 0 &&
            sigs.every(s => s === sigs[0]);
        if (allSame) {
            repeatGroups.push({ groupEl: container, addBtn, rows: children });
        }
    });
    // mark row elements so the main field loop can tag them.
    //
    // Row identity comes directly from the row elements `repeatGroups` already
    // discovered generically (structurally-identical siblings under a common
    // container) -- there is no need, and it is actively wrong, to re-derive
    // "which element is the row" via guessed class names or id patterns. A
    // form whose repeating rows share one common wrapper (e.g. a table body
    // with class names unrelated to any per-row marker) would have every row
    // resolve to that same shared ancestor under a class/id-pattern guess,
    // and since rowMembership is a Map keyed by DOM node, each row's entry
    // would silently overwrite the previous one -- collapsing every row's
    // fields onto whichever row happened to be inserted last. Keying directly
    // off the real, distinct row elements avoids that collision entirely and
    // keeps the logic generic across markup conventions.
    const rowMembership = new Map();
    repeatGroups.forEach((g, gi) => {
        g.rows.forEach((row, ri) => {
            rowMembership.set(row, {
                groupIdx: gi,
                rowIndex: ri,
            });
        });
    });
    function ownerRow(el) {
        let node = el;
        while (node) {
            const hit = rowMembership.get(node);
            if (hit)
                return hit;
            node = node.parentElement;
        }
        return null;
    }
    // --- main field walk ---------------------------------------------------
    const refCounter = { n: 0 };
    const nextRef = () => `f${refCounter.n++}`;
    const fields = [];
    const handledRadioGroups = new Set();
    const allInputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])')).filter(el => isVisible(el));
    // assign a data-agent-ref attribute so the fill layer can re-locate elements
    allInputs.forEach((el) => {
        if (el.type === "radio") {
            const name = el.name;
            if (!name || handledRadioGroups.has(name))
                return;
            handledRadioGroups.add(name);
            const group = Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`)).filter(g => isVisible(g));
            ;
            const visible = group.some((g) => isVisible(g));
            const first = group[0];
            // label for a radio group: look above the group, not at individual radio's own label
            let groupLabel = "";
            const container = first.closest("div") || first.parentElement;
            let node = container;
            for (let hop = 0; hop < 6 && node && !groupLabel; hop++) {
                let sib = node.previousElementSibling;
                while (sib && !groupLabel) {
                    if (sib.tagName === "LABEL" || /^H[1-6]$/.test(sib.tagName) || sib.tagName === "P") {
                        const t = textOf(sib);
                        if (t)
                            groupLabel = t;
                    }
                    sib = sib.previousElementSibling;
                }
                node = node.parentElement;
            }
            const options = group.map((g) => ({
                value: g.value,
                text: findLabelFor(g) || g.value,
            }));
            const checked = group.find((g) => g.checked);
            const ref = nextRef();
            group.forEach((g) => g.setAttribute("data-agent-ref", ref));
            const owner = ownerRow(first);
            fields.push({
                refId: ref,
                kind: "radio-group",
                label: groupLabel,
                required: group.some((g) => g.required) || labelSuggestsRequired(groupLabel),
                visible,
                currentValue: checked?.value,
                options,
                repeat: owner ? { groupRefId: `g${owner.groupIdx}`, rowIndex: owner.rowIndex } : undefined,
            });
            return;
        }
        const ref = nextRef();
        el.setAttribute("data-agent-ref", ref);
        const label = findLabelFor(el);
        const kind = kindFor(el);
        const visible = isVisible(el);
        const helper = findHelperText(el, label);
        const owner = ownerRow(el);
        let options;
        if (el.tagName === "SELECT") {
            options = Array.from(el.options).map((o) => ({ value: o.value, text: o.text }));
        }
        let currentValue;
        if (kind === "checkbox")
            currentValue = String(el.checked);
        else
            currentValue = el.value;
        fields.push({
            refId: ref,
            kind,
            label,
            helperText: helper || undefined,
            placeholder: el.placeholder || undefined,
            required: el.required ||
                el.getAttribute("aria-required") === "true" ||
                el.classList.contains("required") ||
                labelSuggestsRequired(label),
            visible,
            currentValue,
            options,
            pattern: el.pattern || undefined,
            maxLength: el.maxLength > 0 ? el.maxLength : undefined,
            repeat: owner ? { groupRefId: `g${owner.groupIdx}`, rowIndex: owner.rowIndex } : undefined,
            isAttestation: kind === "checkbox" && looksLikeAttestation(label) ? true : undefined,
        });
    });
    // --- action buttons (Next/Continue/Submit/Add), excluding ones inside rows
    // --- action buttons (button + submit/button inputs)
    const actionButtons = [];
    const actions = document.querySelectorAll('button,input[type="submit"],input[type="button"]');
    actions.forEach((el) => {
        if (!isVisible(el))
            return;
        const txt = textOf(el).toLowerCase();
        if (ownerRow(el) &&
            !/save|continue|submit|next|finish/.test(txt)) {
            return;
        }
        const ref = nextRef();
        el.setAttribute("data-agent-ref", ref);
        let text = "";
        if (el instanceof HTMLButtonElement) {
            text = textOf(el);
        }
        else if (el instanceof HTMLInputElement) {
            text = (el.value || "").trim();
        }
        if (!text) {
            text =
                (el.getAttribute("aria-label") || "").trim() ||
                    (el.getAttribute("title") || "").trim();
        }
        actionButtons.push({
            refId: ref,
            text,
        });
    });
    // --- repeat group summary for the mapper -------------------------------
    const repeatGroupsOut = repeatGroups.map((g, gi) => {
        const addRef = g.addBtn?.getAttribute("data-agent-ref") || "";
        const rowFieldLabels = fields
            .filter((f) => f.repeat && f.repeat.groupRefId === `g${gi}` && f.repeat.rowIndex === 0)
            .map((f) => f.label);
        // A group is only actionable if its rows are currently rendered. This is
        // now largely guaranteed by the visibility filter applied when `children`
        // was built above, but we keep the check here too as a defensive
        // double-check in case the DOM changes between detection and this
        // summary being read (e.g. an in-page animation).
        const visible = g.rows.length > 0 && g.rows.every((r) => isVisible(r));
        return {
            groupRefId: `g${gi}`,
            addButtonRefId: addRef,
            currentRowCount: g.rows.length,
            rowFieldLabels,
            visible,
        };
    });
    // --- visible validation errors -----------------------------------------
    const visibleErrors = [];
    document
        .querySelectorAll('[role="alert"],[class*="err" i],[class*="invalid" i],[class*="validation" i],[class*="warning" i],.error,.errors,.validation-summary-errors,.field-validation-error,span.error,li.error')
        .forEach((e) => {
        if (isVisible(e)) {
            const t = textOf(e);
            if (t)
                visibleErrors.push(t);
        }
    });
    return { fields, repeatGroups: repeatGroupsOut, actionButtons, visibleErrors };
}
export async function perceivePage(page, pageIndex) {
    const raw = await page.evaluate(extractInBrowser);
    return {
        pageIndex,
        fields: raw.fields,
        repeatGroups: raw.repeatGroups,
        actionButtons: raw.actionButtons,
        visibleErrors: raw.visibleErrors,
    };
}
