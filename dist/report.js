import { promises as fs } from "node:fs";
import path from "node:path";
export async function writeArtifacts(outDir, formLabel, report) {
    await fs.mkdir(outDir, { recursive: true });
    const logPath = path.join(outDir, `${formLabel}.decision-log.json`);
    const confirmationPath = path.join(outDir, `${formLabel}.confirmation.json`);
    await fs.writeFile(logPath, JSON.stringify(report, null, 2), "utf8");
    await fs.writeFile(confirmationPath, JSON.stringify({
        form: report.form,
        outcome: report.outcome,
        reason: report.reason ?? null,
        confirmationData: report.confirmationData,
        fieldsFlagged: report.fieldsFlagged,
    }, null, 2), "utf8");
    return { logPath, confirmationPath };
}
