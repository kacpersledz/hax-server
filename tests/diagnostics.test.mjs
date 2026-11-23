import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createDiagnostics } from '../diagnostics/buffer.mjs';
import { StatsDatabase } from '../stats/database.mjs';

test('buffer bounds history, samples at 10 Hz and copies exact contacts', () => {
    const d = createDiagnostics();
    const item = { timestamp: 0, type: 'contact', position: { x: 3 } };
    d.event(item); item.position.x = 99;
    d.event({ timestamp: 1, type: 'contact', source: 'proximity' });
    d.sample({ timestamp: 0 }); d.sample({ timestamp: 99 }); d.sample({ timestamp: 100 });
    let report = d.report({ trigger: 'manual', timestamp: 100 });
    assert.equal(report.events[0].position.x, 3);
    assert.equal(report.events.length, 2);
    assert.equal(report.snapshots.length, 2);
    report.events[0].position.x = 50;
    report = d.report({ trigger: 'auto', timestamp: 180001 });
    assert.equal(report.events.length, 1);
    assert.equal(report.snapshots.length, 1);
});

test('SQLite round trip, retention, size limit and CLI export', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hax-diag-'));
    const dbPath = join(dir, 'stats.db');
    const db = new StatsDatabase(dbPath);
    try {
        db.initialize();
        const report = createDiagnostics().report({ trigger: 'manual', timestamp: Date.now(), comment: 'test' });
        for (let i = 0; i < 101; i++) db.saveDiagnosticReport(report);
        assert.equal(db.listDiagnosticReports().length, 100);
        assert.equal(db.getDiagnosticReport(1), null);
        assert.deepEqual(db.getDiagnosticReport(101), report);
        assert.throws(() => db.saveDiagnosticReport({ ...report, comment: 'x'.repeat(9 * 1024 * 1024) }), /8 MiB/);
        const cli = spawnSync(process.execPath, [new URL('../scripts/diagnostics.mjs', import.meta.url).pathname, 'export', '101'],
            { cwd: dir, env: { ...process.env, DIAGNOSTICS_DB: dbPath }, encoding: 'utf8' });
        assert.equal(cli.status, 0, cli.stderr);
        assert.deepEqual(JSON.parse(readFileSync(join(dir, 'diagnostic-report-101.json'), 'utf8')), report);
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
