import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, statSync, copyFileSync, renameSync, unlinkSync, existsSync } from 'fs';
import { dirname, join } from 'path';

const BACKUP_FILENAME_RE = /^stats_backup_\d+(?:_safety)?\.db$/;

function ensureBackupDir(dbPath) {
    const backupsDir = join(dirname(dbPath), 'backups');
    mkdirSync(backupsDir, { recursive: true });
    return backupsDir;
}

function generateBackupFilename(safety = false, backupsDir = null) {
    let timestamp = Date.now();
    let filename;
    do {
        filename = `stats_backup_${timestamp}${safety ? '_safety' : ''}.db`;
        timestamp += 1;
    } while (backupsDir && existsSync(join(backupsDir, filename)));
    return filename;
}

function validateBackupFilename(filename) {
    if (typeof filename !== 'string' || !BACKUP_FILENAME_RE.test(filename)) {
        throw new Error('Invalid backup filename format');
    }
}

function removeSqliteSidecars(dbPath) {
    for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
            unlinkSync(sidecar);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw new Error(`Could not remove SQLite sidecar: ${sidecar}`);
            }
        }
    }
}

/**
 * StatsDatabase - handles all SQLite operations for Haxball stats
 */
export class StatsDatabase {
    constructor(dbPath) {
        this.db = new Database(dbPath);
        this.dbPath = dbPath;
        this.db.pragma('journal_mode = WAL'); // Better performance
    }

    /**
     * Initialize database schema with versioning system
     *
     * This uses a migration-based approach where each version represents
     * a set of schema changes. To add new changes in the future:
     * 1. Add a new migration block (e.g., "if (currentVersion < 2)")
     * 2. Make your changes (ALTER TABLE, CREATE TABLE, etc.)
     * 3. Update the version number
     *
     * For complex changes (removing columns, changing types), use the pattern:
     * - CREATE TABLE new_table (...)
     * - INSERT INTO new_table SELECT ... FROM old_table
     * - DROP TABLE old_table
     * - ALTER TABLE new_table RENAME TO old_table
     */
    initialize() {
        // Create schema_version table if it doesn't exist
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY
            )
        `);

        // Get current schema version
        const row = this.db.prepare('SELECT version FROM schema_version').get();
        let currentVersion = row ? row.version : 0;

        console.log(`[DB] Current schema version: ${currentVersion}`);

        // ========================================
        // MIGRATION 1: Initial schema
        // ========================================
        if (currentVersion < 1) {
            console.log('[DB] Running migration 1: Initial schema');

            // Create players table
            this.db.exec(`
                CREATE TABLE players (
                    auth TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    goals INTEGER DEFAULT 0,
                    assists INTEGER DEFAULT 0,
                    own_goals INTEGER DEFAULT 0,
                    games INTEGER DEFAULT 0,
                    wins INTEGER DEFAULT 0,
                    losses INTEGER DEFAULT 0,
                    draws INTEGER DEFAULT 0,
                    clean_sheets INTEGER DEFAULT 0,
                    minutes_played INTEGER DEFAULT 0,
                    current_streak INTEGER DEFAULT 0,
                    best_streak INTEGER DEFAULT 0,
                    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Create matches table
            this.db.exec(`
                CREATE TABLE matches (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    score_red INTEGER NOT NULL,
                    score_blue INTEGER NOT NULL,
                    duration INTEGER DEFAULT 0
                )
            `);

            // Create match_players table
            this.db.exec(`
                CREATE TABLE match_players (
                    match_id INTEGER,
                    player_auth TEXT NOT NULL,
                    team INTEGER NOT NULL CHECK (team IN (1, 2)),
                    goals INTEGER DEFAULT 0,
                    assists INTEGER DEFAULT 0,
                    FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
                    FOREIGN KEY (player_auth) REFERENCES players(auth)
                )
            `);

            // Create indexes for faster queries
            this.db.exec(`
                CREATE INDEX idx_match_players_match
                ON match_players(match_id)
            `);
            this.db.exec(`
                CREATE INDEX idx_match_players_player
                ON match_players(player_auth)
            `);

            // Update schema version
            if (currentVersion === 0) {
                this.db.exec('INSERT INTO schema_version VALUES (1)');
            } else {
                this.db.exec('UPDATE schema_version SET version = 1');
            }
            currentVersion = 1;
            console.log('[DB] Migration 1 completed');
        }

        // ========================================
        // FUTURE MIGRATIONS GO HERE
        // ========================================
        // Example migration 2 (simple ALTER):
        // if (currentVersion < 2) {
        //     console.log('[DB] Running migration 2: Add shots column');
        //     this.db.exec(`ALTER TABLE players ADD COLUMN shots INTEGER DEFAULT 0`);
        //     this.db.exec('UPDATE schema_version SET version = 2');
        //     currentVersion = 2;
        //     console.log('[DB] Migration 2 completed');
        // }
        //
        // Example migration 3 (complex - removing column):
        // if (currentVersion < 3) {
        //     console.log('[DB] Running migration 3: Remove old_column');
        //     this.db.exec(`CREATE TABLE players_new (...)`);
        //     this.db.exec(`INSERT INTO players_new SELECT ... FROM players`);
        //     this.db.exec(`DROP TABLE players`);
        //     this.db.exec(`ALTER TABLE players_new RENAME TO players`);
        //     this.db.exec('UPDATE schema_version SET version = 3');
        //     currentVersion = 3;
        //     console.log('[DB] Migration 3 completed');
        // }

        console.log(`[DB] Schema up to date (version ${currentVersion})`);
    }

    /**
     * Create a backup of the database file
     * Stores backups in data/backups/ with timestamp from Date.now()
     */
    async createBackup() {
        try {
            // TODO: Add explicit backup retention; backups currently grow without a limit.
            const backupsDir = ensureBackupDir(this.dbPath);

            const backupPath = join(backupsDir, generateBackupFilename(false, backupsDir));
            await this.db.backup(backupPath);

            console.log(`[DB] Backup created: ${backupPath}`);
            return backupPath;
        } catch (error) {
            console.error('[DB] Error creating backup:', error);
            throw error;
        }
    }

    /**
     * Get player by auth
     */
    getPlayer(auth) {
        const stmt = this.db.prepare('SELECT * FROM players WHERE auth = ?');
        return stmt.get(auth);
    }

    /**
     * Get player by name (case-insensitive)
     */
    getPlayerByName(name) {
        const stmt = this.db.prepare('SELECT * FROM players WHERE LOWER(name) = LOWER(?)');
        return stmt.get(name);
    }

    /**
     * Update or insert player (upsert)
     */
    upsertPlayer(auth, name) {
        const stmt = this.db.prepare(`
            INSERT INTO players (auth, name, last_seen)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(auth) DO UPDATE SET
                name = excluded.name,
                last_seen = CURRENT_TIMESTAMP
        `);
        stmt.run(auth, name);
    }

    /**
     * Update player statistics
     */
    updatePlayerStats(auth, stats) {
        const player = this.getPlayer(auth);
        if (!player) return;

        const fields = [];
        const values = [];

        // Build dynamic update query
        for (const [key, value] of Object.entries(stats)) {
            if (key === 'current_streak' || key === 'best_streak') {
                fields.push(`${key} = ?`);
                values.push(value);
            } else {
                fields.push(`${key} = ${key} + ?`);
                values.push(value);
            }
        }

        if (fields.length === 0) return;

        values.push(auth);
        const stmt = this.db.prepare(`
            UPDATE players
            SET ${fields.join(', ')}, last_seen = CURRENT_TIMESTAMP
            WHERE auth = ?
        `);
        stmt.run(...values);
    }

    /**
     * Get top players by goals
     */
    getTopPlayers(limit = 10) {
        const stmt = this.db.prepare(`
            SELECT * FROM players
            ORDER BY goals DESC, games ASC
            LIMIT ?
        `);
        return stmt.all(limit);
    }

    /**
     * Get all players for admin tools
     */
    getAllPlayers() {
        const stmt = this.db.prepare(`
            SELECT *
            FROM players
            ORDER BY LOWER(name), last_seen DESC
        `);
        return stmt.all();
    }

    /**
     * Save match to database
     */
    saveMatch(matchData) {
        const insertMatch = this.db.prepare(`
            INSERT INTO matches (score_red, score_blue, duration)
            VALUES (?, ?, ?)
        `);

        const insertPlayer = this.db.prepare(`
            INSERT INTO match_players (match_id, player_auth, team, goals, assists)
            VALUES (?, ?, ?, ?, ?)
        `);

        // Transaction for atomicity
        const saveTransaction = this.db.transaction((data) => {
            const result = insertMatch.run(data.scoreRed, data.scoreBlue, data.duration);
            const matchId = result.lastInsertRowid;

            // Save all players
            for (const player of data.players) {
                insertPlayer.run(matchId, player.auth, player.team, player.goals, player.assists);
            }

            return matchId;
        });

        return saveTransaction(matchData);
    }

    /**
     * Get last match with players
     */
    getLastMatch() {
        const stmt = this.db.prepare(`
            SELECT * FROM matches
            ORDER BY timestamp DESC
            LIMIT 1
        `);
        const match = stmt.get();

        if (!match) return null;

        // Get players for this match
        const playersStmt = this.db.prepare(`
            SELECT mp.*, p.name
            FROM match_players mp
            JOIN players p ON mp.player_auth = p.auth
            WHERE mp.match_id = ?
        `);
        const players = playersStmt.all(match.id);

        return {
            ...match,
            players
        };
    }

    /**
     * Clear all statistics (delete all data from tables)
     */
    async clearStats() {
        // Create backup first - if it fails, delete will not proceed
        const backupPath = await this.createBackup();
        console.log('[DB] Backup successful, proceeding with clear stats');

        const clearTransaction = this.db.transaction(() => {
            this.db.exec('DELETE FROM match_players');
            this.db.exec('DELETE FROM matches');
            this.db.exec('DELETE FROM players');
        });

        clearTransaction();
        console.log('[DB] All statistics cleared');
    }

    /**
     * Delete test players and their related data
     * Removes all players whose name starts with '___test'
     */
    async deleteTestPlayers() {
        // Create backup first - if it fails, delete will not proceed
        const backupPath = await this.createBackup();
        console.log('[DB] Backup successful, proceeding with delete test players');

        const deleteTransaction = this.db.transaction(() => {
            // Get all test player auths
            const testPlayers = this.db.prepare(`
                SELECT auth FROM players WHERE name LIKE '___test%'
            `).all();

            if (testPlayers.length === 0) {
                console.log('[DB] No test players found to delete');
                return 0;
            }

            const testAuths = testPlayers.map(p => p.auth);
            const placeholders = testAuths.map(() => '?').join(',');

            // Delete from match_players
            this.db.prepare(`DELETE FROM match_players WHERE player_auth IN (${placeholders})`).run(...testAuths);

            // Delete matches where all players were test players
            this.db.exec(`
                DELETE FROM matches WHERE id IN (
                    SELECT DISTINCT m.id
                    FROM matches m
                    LEFT JOIN match_players mp ON m.id = mp.match_id
                    LEFT JOIN players p ON mp.player_auth = p.auth
                    GROUP BY m.id
                    HAVING COUNT(DISTINCT CASE WHEN p.name NOT LIKE '___test%' THEN p.auth END) = 0
                )
            `);

            // Delete test players
            this.db.prepare(`DELETE FROM players WHERE auth IN (${placeholders})`).run(...testAuths);

            console.log(`[DB] Deleted ${testPlayers.length} test players and their data`);
            return testPlayers.length;
        });

        return deleteTransaction();
    }

    /**
     * Delete a specific player and their related data
     * Removes a player by name (case-insensitive) and all their match records
     */
    async deletePlayerStats(playerName) {
        // Create backup first - if it fails, delete will not proceed
        const backupPath = await this.createBackup();
        console.log('[DB] Backup successful, proceeding with delete player stats');

        const deleteTransaction = this.db.transaction(() => {
            // Get the player by name
            const player = this.db.prepare(`
                SELECT auth FROM players WHERE LOWER(name) = LOWER(?)
            `).get(playerName);

            if (!player) {
                console.log(`[DB] Player "${playerName}" not found`);
                return null;
            }

            const playerAuth = player.auth;

            // Delete from match_players
            this.db.prepare(`DELETE FROM match_players WHERE player_auth = ?`).run(playerAuth);

            // Delete matches where this was the only player
            this.db.exec(`
                DELETE FROM matches WHERE id IN (
                    SELECT DISTINCT m.id
                    FROM matches m
                    LEFT JOIN match_players mp ON m.id = mp.match_id
                    GROUP BY m.id
                    HAVING COUNT(mp.player_auth) = 0
                )
            `);

            // Delete the player
            this.db.prepare(`DELETE FROM players WHERE auth = ?`).run(playerAuth);

            console.log(`[DB] Deleted player "${playerName}" and their data`);
            return playerName;
        });

        return deleteTransaction();
    }

    /**
     * Merge one player into another by auth
     * Source player is removed after stats and match history are merged into target
     */
    async mergePlayers(sourceAuth, targetAuth) {
        if (!sourceAuth || !targetAuth) {
            throw new Error('Source auth and target auth are required');
        }

        if (sourceAuth === targetAuth) {
            throw new Error('Source auth and target auth must be different');
        }

        // Create backup first - if it fails, merge will not proceed
        const backupPath = await this.createBackup();
        console.log('[DB] Backup successful, proceeding with player merge');

        const mergeTransaction = this.db.transaction(() => {
            const source = this.getPlayer(sourceAuth);
            const target = this.getPlayer(targetAuth);

            if (!source) {
                throw new Error(`Source player not found: ${sourceAuth}`);
            }

            if (!target) {
                throw new Error(`Target player not found: ${targetAuth}`);
            }

            const conflictRows = this.db.prepare(`
                SELECT source_mp.match_id, source_mp.goals, source_mp.assists
                FROM match_players source_mp
                INNER JOIN match_players target_mp
                    ON target_mp.match_id = source_mp.match_id
                    AND target_mp.player_auth = ?
                WHERE source_mp.player_auth = ?
            `).all(targetAuth, sourceAuth);

            const mergedMatchConflicts = conflictRows.length;

            const mergeMatchStats = this.db.prepare(`
                UPDATE match_players
                SET goals = goals + ?, assists = assists + ?
                WHERE match_id = ? AND player_auth = ?
            `);

            const deleteSourceMatchRow = this.db.prepare(`
                DELETE FROM match_players
                WHERE match_id = ? AND player_auth = ?
            `);

            for (const row of conflictRows) {
                mergeMatchStats.run(row.goals, row.assists, row.match_id, targetAuth);
                deleteSourceMatchRow.run(row.match_id, sourceAuth);
            }

            const moveResult = this.db.prepare(`
                UPDATE match_players
                SET player_auth = ?
                WHERE player_auth = ?
            `).run(targetAuth, sourceAuth);

            this.db.prepare(`
                UPDATE players
                SET
                    goals = goals + ?,
                    assists = assists + ?,
                    own_goals = own_goals + ?,
                    games = games + ?,
                    wins = wins + ?,
                    losses = losses + ?,
                    draws = draws + ?,
                    clean_sheets = clean_sheets + ?,
                    minutes_played = minutes_played + ?,
                    best_streak = MAX(best_streak, ?),
                    last_seen = MAX(last_seen, ?)
                WHERE auth = ?
            `).run(
                source.goals,
                source.assists,
                source.own_goals,
                source.games,
                source.wins,
                source.losses,
                source.draws,
                source.clean_sheets,
                source.minutes_played,
                source.best_streak,
                source.last_seen,
                targetAuth
            );

            this.db.prepare('DELETE FROM players WHERE auth = ?').run(sourceAuth);

            const finalStats = this.getPlayer(targetAuth);

            console.log(`[DB] Merged player "${source.name}" (${sourceAuth}) into "${target.name}" (${targetAuth})`);

            return {
                source: {
                    auth: source.auth,
                    name: source.name
                },
                target: {
                    auth: target.auth,
                    name: target.name
                },
                movedMatchRows: moveResult.changes,
                mergedMatchConflicts,
                finalStats
            };
        });

        return mergeTransaction();
    }

    /**
     * List all available backups with metadata
     */
    listBackups() {
        try {
            const backupsDir = ensureBackupDir(this.dbPath);

            // Check if backups directory exists
            let files;
            try {
                files = readdirSync(backupsDir);
            } catch (e) {
                // Directory doesn't exist yet
                return [];
            }

            const backups = files
                .filter(file => BACKUP_FILENAME_RE.test(file))
                .map(filename => {
                    const filePath = join(backupsDir, filename);
                    const stats = statSync(filePath);

                    // Extract timestamp from filename: stats_backup_[TIMESTAMP].db
                    const match = filename.match(/stats_backup_(\d+)\.db/);
                    const timestamp = match ? parseInt(match[1]) : 0;

                    return {
                        filename,
                        filepath: filePath,
                        size: stats.size,
                        timestamp,
                        createdAt: stats.birthtime,
                        modifiedAt: stats.mtime,
                        type: filename.endsWith('_safety.db') ? 'safety' : 'backup'
                    };
                });

            return backups;
        } catch (error) {
            console.error('[DB] Error listing backups:', error);
            throw error;
        }
    }

    /**
     * Restore database from a backup file
     * Note: This should only be called when room is stopped (no active connection)
     */
    async restoreBackup(filename) {
        let safetyBackupPath;
        let temporaryPath;
        let databaseClosed = false;
        let databaseReplaced = false;

        try {
            validateBackupFilename(filename);

            const backupsDir = ensureBackupDir(this.dbPath);
            const backupPath = join(backupsDir, filename);

            // Check if backup exists
            try {
                statSync(backupPath);
            } catch (e) {
                throw new Error(`Backup file not found: ${filename}`);
            }

            await this.validateBackupFile(backupPath);

            // Create a consistent safety snapshot before closing the WAL connection.
            safetyBackupPath = join(backupsDir, generateBackupFilename(true, backupsDir));
            await this.db.backup(safetyBackupPath);
            await this.validateBackupFile(safetyBackupPath);
            console.log(`[DB] Safety backup created: ${safetyBackupPath}`);

            this.db.close();
            databaseClosed = true;
            removeSqliteSidecars(this.dbPath);

            temporaryPath = `${this.dbPath}.restore-tmp`;
            copyFileSync(backupPath, temporaryPath);
            if (statSync(temporaryPath).size <= 0) {
                throw new Error('Restore file is empty');
            }
            renameSync(temporaryPath, this.dbPath);
            temporaryPath = null;
            databaseReplaced = true;

            // Reconnect to the restored database
            this.db = new Database(this.dbPath);
            this.db.pragma('journal_mode = WAL');
            databaseClosed = false;
            await this.validateOpenDatabase();
            console.log('[DB] Database connection re-established after restore');

            return {
                message: `Database successfully restored from backup: ${filename}`,
                restoredFrom: filename,
                timestamp: parseInt(filename.match(/\d+/)[0])
            };
        } catch (error) {
            console.error('[DB] Error restoring backup:', error);

            if (temporaryPath) {
                try { unlinkSync(temporaryPath); } catch (cleanupError) {
                    if (cleanupError.code !== 'ENOENT') console.error('[DB] Could not clean restore temp file:', cleanupError);
                }
            }

            // Roll back to the consistent safety snapshot when replacement already started.
            try {
                const shouldReconnect = databaseReplaced || databaseClosed || !this.db.open;
                if (databaseReplaced || databaseClosed) {
                    removeSqliteSidecars(this.dbPath);
                    const rollbackPath = `${this.dbPath}.restore-tmp`;
                    copyFileSync(safetyBackupPath, rollbackPath);
                    renameSync(rollbackPath, this.dbPath);
                }
                if (shouldReconnect) {
                    if (this.db.open) this.db.close();
                    this.db = new Database(this.dbPath);
                    this.db.pragma('journal_mode = WAL');
                    await this.validateOpenDatabase();
                }
            } catch (e) {
                console.error('[DB] CRITICAL: Could not reconnect to database after restore error:', e);
            }

            const publicError = new Error(error.message);
            publicError.publicMessage = error.publicMessage || error.message;
            throw publicError;
        }
    }

    async validateBackupFile(backupPath) {
        let backupDb;
        try {
            backupDb = new Database(backupPath, { readonly: true, fileMustExist: true });
            const integrity = backupDb.pragma('integrity_check', { simple: true });
            if (integrity !== 'ok') {
                throw new Error('Backup failed SQLite integrity_check');
            }
            const foreignKeys = backupDb.prepare('PRAGMA foreign_key_check').all();
            if (foreignKeys.length > 0) {
                throw new Error('Backup failed SQLite foreign_key_check');
            }
        } catch (error) {
            throw new Error(error.message.startsWith('Backup failed') ? error.message : 'Backup is not a valid SQLite database');
        } finally {
            if (backupDb) backupDb.close();
        }
    }

    async validateOpenDatabase() {
        const integrity = this.db.pragma('integrity_check', { simple: true });
        if (integrity !== 'ok') throw new Error('Restored database failed SQLite integrity_check');
        const foreignKeys = this.db.prepare('PRAGMA foreign_key_check').all();
        if (foreignKeys.length > 0) throw new Error('Restored database failed SQLite foreign_key_check');
    }

    /**
     * Close database connection
     */
    close() {
        this.db.close();
    }
}
