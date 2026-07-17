// ---------------------------------------------------------------------------
// Core shared types. These are the contracts between perceive -> map -> fill.
// Keeping them in one place makes the LLM response schema and the DOM
// extraction schema easy to keep in sync.
// ---------------------------------------------------------------------------

export type FieldKind =
  | "text"
  | "email"
  | "tel"
  | "date"
  | "number"
  | "textarea"
  | "select"
  | "radio-group"
  | "checkbox";

export interface FieldOption {
  /** The value attribute submitted with the form (may be empty string) */
  value: string;
  /** The human-visible text of the option/radio label */
  text: string;
}

/**
 * A single interactive field as perceived from the live DOM. `refId` is an
 * opaque handle assigned at perception time (f0, f1, ...) -- it is NOT tied
 * to any real id/name in the underlying page, so the mapper and LLM never
 * need to know or reason about page-specific attribute names.
 */
export interface PerceivedField {
  refId: string;
  kind: FieldKind;
  label: string;
  helperText?: string;
  placeholder?: string;
  required: boolean;
  visible: boolean;
  currentValue?: string;
  options?: FieldOption[];
  pattern?: string;
  maxLength?: number;
  /** true for checkbox fields that look like an attestation/certification statement */
  isAttestation?: boolean;
  /** set when this field belongs to a detected repeating row */
  repeat?: {
    groupRefId: string;
    rowIndex: number;
  };
}

/** A detected "add another row" affordance for a repeating section. */
export interface RepeatGroup {
  groupRefId: string;
  addButtonRefId: string;
  currentRowCount: number;
  /** labels found in a single row, used to match against an answermap array's item shape */
  rowFieldLabels: string[];
}

export interface PagePerception {
  pageIndex: number;
  fields: PerceivedField[];
  repeatGroups: RepeatGroup[];
  /** all currently-visible buttons that are not inside a repeat row (Next/Submit/Add candidates) */
  actionButtons: { refId: string; text: string }[];
  /** any visible validation error text found on the page */
  visibleErrors: string[];
}

// ---------------------------------------------------------------------------
// Answermap
// ---------------------------------------------------------------------------

export type AnswerValue = string | number | boolean;

export interface AnswerEntry {
  answer: AnswerValue | Record<string, AnswerValue>[];
}

export type AnswerMap = Record<string, AnswerEntry>;

// ---------------------------------------------------------------------------
// LLM mapping contract
// ---------------------------------------------------------------------------

export type MapAction = "fill" | "select" | "check" | "uncheck" | "skip" | "flag";

export interface FieldMapping {
  refId: string;
  /** dotted path into the answermap, e.g. "ContactPhone" or "ClassCodes[].code" */
  answerKey: string | null;
  /** for select/radio-group: which option (by value) to choose */
  chosenOptionValue?: string;
  confidence: number; // 0..1
  reason: string;
  action: MapAction;
  source: "heuristic" | "llm";
}

export interface MappingResult {
  pageIndex: number;
  mappings: FieldMapping[];
}

// ---------------------------------------------------------------------------
// Decision log / trace
// ---------------------------------------------------------------------------

export interface DecisionLogEntry {
  timestamp: string;
  pageIndex: number;
  refId: string;
  label: string;
  candidateAnswerKey: string | null;
  confidence: number | null;
  reasoning: string;
  action: MapAction | "navigate" | "add-row" | "stuck" | "success";
  detail?: string;
}

export interface FlaggedField {
  pageIndex: number;
  refId: string;
  label: string;
  reason: string;
}

export interface RunReport {
  form: string;
  startedAt: string;
  finishedAt: string;
  outcome: "success" | "stuck" | "error";
  reason?: string;
  pagesVisited: number;
  fieldsFilled: number;
  fieldsFlagged: FlaggedField[];
  confirmationData: unknown | null;
  decisionLog: DecisionLogEntry[];
}