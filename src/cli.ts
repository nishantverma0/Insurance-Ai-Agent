import { promises as fs } from "node:fs";
import path from "node:path";
import { runAgent } from "./agent.js";
import { buildLlmClient } from "./llm.js";
import { writeArtifacts } from "./report.js";
import type { AnswerMap } from "./types.js";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[key] = val;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const formArg = args.form;
  const answersArg = args.answers;
  const outDir = args.out || "artifacts";
  const headless = args.headed !== "true";

  if (!formArg || !answersArg) {
    console.error("Usage: npm run agent -- --form <path-or-url> --answers <answermap.json> [--out artifacts] [--headed true]");
    process.exit(1);
  }

  const answers: AnswerMap = JSON.parse(await fs.readFile(path.resolve(answersArg), "utf8"));
  const formPath = /^https?:\/\//.test(formArg) ? formArg : path.resolve(formArg);

  const llm = buildLlmClient();
  console.log(`[agent] LLM backend: ${llm.name}${llm.name === "mock-offline" ? " (no ANTHROPIC_API_KEY set -- using deterministic offline mapper)" : ""}`);
  console.log(`[agent] Form: ${formPath}`);

  const report = await runAgent({ formPath, answers, llm });

  const label = path.basename(formArg).replace(/\.[^.]+$/, "");
  const { logPath, confirmationPath } = await writeArtifacts(path.resolve(outDir), label, report);

  console.log(`\n[agent] Outcome: ${report.outcome}${report.reason ? ` -- ${report.reason}` : ""}`);
  console.log(`[agent] Pages visited: ${report.pagesVisited}, fields filled: ${report.fieldsFilled}, flagged: ${report.fieldsFlagged.length}`);
  console.log(`[agent] Decision log: ${logPath}`);
  console.log(`[agent] Confirmation:  ${confirmationPath}`);

  if (report.fieldsFlagged.length > 0) {
    console.log(`\n[agent] Fields flagged for human review:`);
    for (const f of report.fieldsFlagged) {
      console.log(`  - page ${f.pageIndex}: "${f.label}" -- ${f.reason}`);
    }
  }

  if (report.outcome !== "success") process.exitCode = 1;
}

main().catch((e) => {
  console.error("[agent] Fatal error:", e);
  process.exit(1);
});
