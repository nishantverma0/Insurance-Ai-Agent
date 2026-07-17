import type { Page } from "playwright";

/** Clicks the perceived "add another row" button `count` times. */
export async function clickAddRow(page: Page, addButtonRefId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await page.locator(`[data-agent-ref="${addButtonRefId}"]`).first().click();
    await page.waitForTimeout(50);
  }
}

/** Ranks visible action buttons by how strongly their text reads as a "final submit" action. */
function submitScore(text: string): number {
  const t = text.toLowerCase();
  if (/submit/.test(t)) return 3;
  if (/finish|complete|send/.test(t)) return 2;
  return 0;
}
function nextScore(text: string): number {
  const t = text.toLowerCase();
  if (/next|continue|save.*continue|proceed/.test(t)) return 2;
  return 0;
}

/** Picks the best "advance the form" button out of the currently visible action buttons. */
export function pickAdvanceButton(actionButtons: { refId: string; text: string }[]): { refId: string; text: string; isFinal: boolean } | null {
  let bestSubmit: { refId: string; text: string; score: number } | null = null;
  let bestNext: { refId: string; text: string; score: number } | null = null;
  for (const b of actionButtons) {
    const s = submitScore(b.text);
    const n = nextScore(b.text);
    if (s > 0 && (!bestSubmit || s > bestSubmit.score)) bestSubmit = { ...b, score: s };
    if (n > 0 && (!bestNext || n > bestNext.score)) bestNext = { ...b, score: n };
  }
  if (bestSubmit) return { refId: bestSubmit.refId, text: bestSubmit.text, isFinal: true };
  if (bestNext) return { refId: bestNext.refId, text: bestNext.text, isFinal: false };
  return null;
}

export async function clickButton(page: Page, refId: string, timeoutMs = 8000): Promise<void> {
  await page.locator(`[data-agent-ref="${refId}"]`).first().click({ timeout: timeoutMs });
  await Promise.race([
    page.waitForLoadState("networkidle").catch(() => {}),
    page.waitForTimeout(1000)
]);
}

export interface OutcomeCheck {
  advanced: boolean;
  success: boolean;
  confirmationData: unknown | null;
}

function isVisibleInBrowser(el: Element): boolean {
  const style = window.getComputedStyle(el as HTMLElement);
  if (style.display === "none" || style.visibility === "hidden") return false;
  let node: Element | null = el;
  while (node) {
    const s = window.getComputedStyle(node as HTMLElement);
    if (s.display === "none" || s.visibility === "hidden") return false;
    node = node.parentElement;
  }
  return true;
}

/**
 * The single source of truth for "what does the visible form look like right
 * now" -- used for BOTH the before and after snapshot, so they're always an
 * apples-to-apples comparison (a prior version computed the "before" signature
 * over ALL inputs and the "after" signature over only VISIBLE inputs, which
 * could never match even when nothing had actually changed).
 */
export async function getVisibleFieldSignature(page: Page): Promise<string> {
  return page.evaluate(() => {
    function isVisible(el: Element): boolean {
      const style = window.getComputedStyle(el as HTMLElement);
      if (style.display === "none" || style.visibility === "hidden") return false;
      let node: Element | null = el;
      while (node) {
        const s = window.getComputedStyle(node as HTMLElement);
        if (s.display === "none" || s.visibility === "hidden") return false;
        node = node.parentElement;
      }
      return true;
    }
    const inputs = Array.from(document.querySelectorAll("input, select, textarea"));
    return inputs
      .filter((i) => isVisible(i))
      .map((i) => (i as HTMLInputElement).id || (i as HTMLInputElement).name || "")
      .join("|");
  });
}

/**
 * Detects whether a click advanced the form, completed it, or left it
 * stuck. Success is detected generically: a visible <pre>/<code> block
 * (a very common pattern for "here's the JSON we captured") that parses
 * as JSON, combined with the absence of any remaining visible required
 * empty inputs.
 */
export async function checkOutcome(page: Page, priorVisibleFieldSignature: string): Promise<OutcomeCheck> {
  const result = await page.evaluate(() => {
    function isVisible(el: Element): boolean {
      const style = window.getComputedStyle(el as HTMLElement);
      if (style.display === "none" || style.visibility === "hidden") return false;
      let node: Element | null = el;
      while (node) {
        const s = window.getComputedStyle(node as HTMLElement);
        if (s.display === "none" || s.visibility === "hidden") return false;
        node = node.parentElement;
      }
      return true;
    }
    let confirmationData: unknown = null;
    const validationErrors = Array.from(
    document.querySelectorAll(
        ".error,.validation-error,.field-validation-error,[role='alert'],.text-danger"
    )
)
.filter(isVisible)
.map(e => e.textContent?.trim())
.filter(Boolean);
    document.querySelectorAll("pre, code").forEach((el) => {
      if (confirmationData !== null) return;
      if (!isVisible(el)) return;
      const t = (el.textContent || "").trim();
      if (t.startsWith("{") || t.startsWith("[")) {
        try {
          confirmationData = JSON.parse(t);
        } catch {
          /* not JSON, ignore */
        }
      }
    });

    const inputs = Array.from(document.querySelectorAll("input, select, textarea")) as HTMLInputElement[];
    const visibleFieldSig = inputs
      .filter((i) => isVisible(i))
      .map((i) => i.id || i.name || "")
      .join("|");

    return { confirmationData, visibleFieldSig, validationErrors };
  });
  console.log("Validation Errors:", result.validationErrors);

  const success =
    result.confirmationData !== null && result.validationErrors.length === 0;
  const advanced =
    result.visibleFieldSig !== priorVisibleFieldSignature ||
    result.validationErrors.length === 0;

  console.log("Prior Signature:", priorVisibleFieldSignature);
  console.log("Current Signature:", result.visibleFieldSig);
  console.log("Advanced:", advanced, "Success:", success);

  // Detect a "thank you" page as a success even if we didn't see a JSON block.
  if (!success)
    return {
      advanced,
      success: await detectThankYouPage(page),
      confirmationData: result.confirmationData,
    };

  return { advanced, success, confirmationData: result.confirmationData };
}
async function detectThankYouPage(page: Page): Promise<boolean> {

    return page.evaluate(() => {

        const body =
            document.body.innerText.toLowerCase();

        return (
            body.includes("thank you for your submission") ||
            body.includes("quotation submitted") ||
            body.includes("application received")
        );

    });

}

