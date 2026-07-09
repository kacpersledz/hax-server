import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { StatsDatabase } from '../stats/database.mjs';

const testDir = mkdtempSync(join(tmpdir(), 'hax-backup-restore-'));
const dbPath = join(testDir, 'stats.db');
let db;

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function snapshot(database) {
    return {
        players: database.db.prepare('SELECT auth, name, goals, assists FROM players ORDER BY auth').all(),
        matches: database.db.prepare('SELECT score_red, score_blue, duration FROM matches ORDER BY id').all(),
        matchPlayers: database.db.prepare('SELECT player_auth, team, goals, assists FROM match_players ORDER BY match_id, player_auth').all(),
    };
}

try {
    db = new StatsDatabase(dbPath);
    db.initialize();

    const journalMode = db.db.pragma('journal_mode', { simple: true });
    assert(journalMode === 'wal', `Expected WAL mode, got ${journalMode}`);

    db.upsertPlayer('test-auth-a', '___test-backup-a');
    db.upsertPlayer('test-auth-b', '___test-backup-b');
    db.updatePlayerStats('test-auth-a', { goals: 2, assists: 1 });
    db.updatePlayerStats('test-auth-b', { goals: 1 });
    db.saveMatch({
        scoreRed: 2,
        scoreBlue: 1,
        duration: 90,
        players: [
            { auth: 'test-auth-a', team: 1, goals: 2, assists: 1 },
            { auth: 'test-auth-b', team: 2, goals: 1, assists: 0 },
        ],
    });

    const stateA = snapshot(db);
    const backupPath = await db.createBackup();
    const filename = backupPath.split('/').pop();

    db.upsertPlayer('test-auth-b', '___test-backup-b-modified');
    db.upsertPlayer('test-auth-c', '___test-backup-c');
    db.saveMatch({
        scoreRed: 0,
        scoreBlue: 3,
        duration: 45,
        players: [{ auth: 'test-auth-c', team: 2, goals: 3, assists: 0 }],
    });
    assert(snapshot(db).players.length === 3, 'Post-backup test data was not added');

    await db.restoreBackup(filename);
    const stateAfterRestore = snapshot(db);
    assert(JSON.stringify(stateAfterRestore) === JSON.stringify(stateA), 'Restored state differs from state A');

    const integrity = db.db.pragma('integrity_check', { simple: true });
    assert(integrity === 'ok', `integrity_check returned ${integrity}`);
    const foreignKeys = db.db.prepare('PRAGMA foreign_key_check').all();
    assert(foreignKeys.length === 0, 'foreign_key_check returned violations');

    console.log('PASS: journal_mode = wal');
    console.log('PASS: backup created with StatsDatabase.createBackup()');
    console.log('PASS: post-backup data disappeared after restore');
    console.log('PASS: state before backup equals state after restore');
    console.log('PASS: integrity_check = ok');
    console.log('PASS: foreign_key_check = empty');
} catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
} finally {
    if (db?.db?.open) db.close();
    rmSync(testDir, { recursive: true, force: true });
}
