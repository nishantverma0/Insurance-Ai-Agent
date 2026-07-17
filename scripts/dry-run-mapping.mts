// Exercises the REAL src/map.ts, src/format.ts, src/llm.ts (MockSemanticLlmClient)
// against field lists transcribed from forms/form_a.html and forms/form_b.html.
// This is NOT a substitute for the full Playwright run -- see README.md for why
// that couldn't be executed inside this particular sandbox -- but it validates
// that the actual shipped mapping/formatting/option-resolution logic produces
// sensible decisions against the real answermap.json and the real form field
// shapes, using the exact same code path the live agent uses on each page.
import { promises as fs } from "node:fs";
import { mapPage, buildAnswerCatalog } from "../src/map.js";
import { mapRepeatRowTemplate } from "../src/fill.js";
import { MockSemanticLlmClient } from "../src/llm.js";
import type { AnswerMap, PagePerception, PerceivedField } from "../src/types.js";

const llm = new MockSemanticLlmClient();
const answers: AnswerMap = JSON.parse(await fs.readFile(new URL("../answermap.json", import.meta.url), "utf8"));

function field(p: Partial<PerceivedField> & Pick<PerceivedField, "refId" | "kind" | "label">): PerceivedField {
  return { required: false, visible: true, ...p } as PerceivedField;
}

async function runForm(name: string, pages: PerceivedField[][], repeatPage?: { pageIndex: number; rowTemplate: PerceivedField[]; itemKeys: string[]; rowCount: number }) {
  const usedKeys = new Set<string>();
  const out: any[] = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const perception: PagePerception = { pageIndex, fields: pages[pageIndex], repeatGroups: [], actionButtons: [], visibleErrors: [] };
    const mappings = await mapPage({ perception, answers, llm, usedKeys });
    for (const m of mappings) if (m.answerKey) usedKeys.add(m.answerKey);
    out.push({ pageIndex, mappings });
  }
  if (repeatPage) {
    const positions = await mapRepeatRowTemplate(repeatPage.rowTemplate, repeatPage.itemKeys, llm);
    out.push({ pageIndex: repeatPage.pageIndex, repeatRowTemplateMapping: repeatPage.rowTemplate.map((f, i) => ({ label: f.label, itemKey: positions[i] })) });
  }
  await fs.mkdir(new URL("../artifacts/", import.meta.url), { recursive: true });
  await fs.writeFile(new URL(`../artifacts/${name}.mapping-dry-run.json`, import.meta.url), JSON.stringify(out, null, 2));
  console.log(`wrote artifacts/${name}.mapping-dry-run.json`);
  return out;
}

// ---------------------------------------------------------------------------
// form_a.html
// ---------------------------------------------------------------------------
const formAPages: PerceivedField[][] = [
  [
    field({ refId: "a0", kind: "text", label: "Legal Business Name", required: true }),
    field({ refId: "a1", kind: "text", label: "DBA / Trade Name (if any)" }),
    field({ refId: "a2", kind: "text", label: "Employer Identification Number (EIN)", placeholder: "XX-XXXXXXX", required: true }),
    field({
      refId: "a3", kind: "select", label: "Legal Entity Type", required: true,
      options: ["", "Sole Proprietorship", "Partnership", "Limited Liability Company", "S Corporation", "C Corporation", "Non-Profit Organization"].map((t) => ({ value: t, text: t || "-- Select --" })),
    }),
    field({ refId: "a4", kind: "number", label: "Years in Business", required: true }),
    field({ refId: "a5", kind: "text", label: "Business Website" }),
    field({ refId: "a6", kind: "textarea", label: "Description of Operations", required: true }),
  ],
  [
    field({ refId: "a7", kind: "text", label: "First Name", required: true }),
    field({ refId: "a8", kind: "text", label: "Last Name", required: true }),
    field({ refId: "a9", kind: "email", label: "Email Address", required: true }),
    field({ refId: "a10", kind: "tel", label: "Phone Number", required: true }),
    field({ refId: "a11", kind: "text", label: "Street Address", required: true }),
    field({ refId: "a12", kind: "text", label: "City", required: true }),
    field({
      refId: "a13", kind: "select", label: "State", required: true,
      options: ["", "AL", "AZ", "CA", "GA", "NC", "NV", "SC", "TN"].map((v) => ({ value: v, text: v ? v : "-- Select --" })),
    }),
    field({ refId: "a14", kind: "text", label: "ZIP Code", required: true }),
  ],
  [
    field({ refId: "a15", kind: "date", label: "Requested Effective Date", required: true }),
    field({ refId: "a16", kind: "number", label: "Total Estimated Annual Payroll ($)", required: true }),
    field({ refId: "a17", kind: "number", label: "Number of Full-Time Employees", required: true }),
    field({ refId: "a18", kind: "number", label: "Number of Part-Time Employees" }),
    field({
      refId: "a19", kind: "radio-group", label: "Does the applicant currently carry workers' compensation coverage?", required: true,
      options: [{ value: "Yes", text: "Yes" }, { value: "No", text: "No" }],
    }),
    field({ refId: "a20", kind: "text", label: "Current Carrier Name", required: true }),
    field({ refId: "a21", kind: "number", label: "Current Annual Premium ($)", required: true }),
    field({ refId: "a22", kind: "number", label: "Number of Claims in Current Term", required: true }),
    field({ refId: "a23", kind: "checkbox", label: "I certify that the information provided is accurate to the best of my knowledge.", required: true }),
  ],
];

// ---------------------------------------------------------------------------
// form_b.html
// ---------------------------------------------------------------------------
const formBPages: PerceivedField[][] = [
  [
    field({ refId: "b0", kind: "text", label: "Name of Insured (as registered with the Secretary of State)", required: true }),
    field({ refId: "b1", kind: "text", label: "Doing Business As", helperText: "(leave blank if none)" }),
    field({ refId: "b2", kind: "text", label: "Federal Tax ID", placeholder: "9 digits, format XX-XXXXXXX", required: true }),
    field({
      refId: "b3", kind: "radio-group", label: "Organization Type", required: true,
      options: [{ value: "INDIV", text: "Individual" }, { value: "PART", text: "Partnership" }, { value: "LLC", text: "LLC" }, { value: "CORP", text: "Corporation" }, { value: "OTHER", text: "Other" }],
    }),
    field({ refId: "b4", kind: "text", label: "Nature of Business / Operations", required: true }),
  ],
  [
    field({ refId: "b5", kind: "text", label: "Address Line 1", required: true }),
    field({ refId: "b6", kind: "text", label: "City", required: true }),
    field({
      refId: "b7", kind: "select", label: "State", required: true,
      options: ["", "CA", "AZ", "NV", "GA", "AL", "TN"].map((v) => ({ value: v, text: v ? `${v} - ` : "Choose..." })),
    }),
    field({ refId: "b8", kind: "text", label: "Postal Code", required: true }),
    field({ refId: "b9", kind: "text", label: "County", helperText: "(if known)" }),
    field({ refId: "b10", kind: "text", label: "Contact Person for This Submission", placeholder: "Full name", required: true }),
    field({ refId: "b11", kind: "text", label: "Contact Telephone", helperText: "digits only, e.g. 6195550142", required: true }),
    field({ refId: "b12", kind: "text", label: "Contact E-mail", required: true }),
  ],
  [
    field({ refId: "b13", kind: "text", label: "Proposed Inception Date", placeholder: "MM/DD/YYYY", required: true }),
    field({ refId: "b14", kind: "text", label: "Proposed Expiration Date", placeholder: "MM/DD/YYYY", required: true }),
    field({
      refId: "b15", kind: "radio-group", label: "Has the applicant had workers' compensation insurance in force during the past 12 months?", required: true,
      options: [{ value: "Y", text: "Yes" }, { value: "N", text: "No" }],
    }),
    field({ refId: "b16", kind: "text", label: "Expiring Carrier", required: true }),
    field({
      refId: "b17", kind: "select", label: "Claims reported during the expiring term", required: true,
      options: [{ value: "", text: "Select…" }, { value: "0", text: "None" }, { value: "1", text: "1 claim" }, { value: "2", text: "2 claims" }, { value: "3+", text: "3 or more" }],
    }),
    field({
      refId: "b18", kind: "radio-group", label: "Does the applicant use subcontractors?", required: true,
      options: [{ value: "Y", text: "Yes" }, { value: "N", text: "No" }],
    }),
    field({ refId: "b19", kind: "checkbox", label: "The producer certifies the above statements are true and complete.", required: true }),
  ],
];
const formBRowTemplate: PerceivedField[] = [
  field({ refId: "b20", kind: "text", label: "Code", required: true }),
  field({ refId: "b21", kind: "text", label: "Classification Description" }),
  field({ refId: "b22", kind: "text", label: "# Emp", required: true }),
  field({ refId: "b23", kind: "text", label: "Est. Annual Payroll", required: true }),
];

await runForm("form_a", formAPages);
await runForm("form_b", formBPages, { pageIndex: 2, rowTemplate: formBRowTemplate, itemKeys: ["code", "description", "employees", "annualPayroll"], rowCount: 3 });
