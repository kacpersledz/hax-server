import { writeFileSync } from 'node:fs';
import { StatsDatabase } from '../stats/database.mjs';

const [command, idText] = process.argv.slice(2);
if (command !== 'list' && !(command === 'export' && /^[1-9]\d*$/.test(idText || ''))) {
    console.error('Usage: node scripts/diagnostics.mjs list | export <id>');
    process.exitCode = 1;
} else {
    let db;
    try {
        db = new StatsDatabase(process.env.DIAGNOSTICS_DB || './data/stats.db');
        db.initialize();
        if (command === 'list') console.table(db.listDiagnosticReports());
        else {
            const report = db.getDiagnosticReport(Number(idText));
            if (!report) throw new Error(`Report #${idText} not found`);
            const path = `diagnostic-report-${idText}.json`;
            writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
            console.log(`Exported ${path}`);
        }
    } catch (error) { console.error(error.message); process.exitCode = 1; }
    finally { db?.close(); }
}
