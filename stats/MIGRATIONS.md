# Database Migrations Guide

## 📊 Current Schema Version: 2

This document describes all database migrations and provides examples for adding new ones.

---

## 🔢 Migration History

### Migration 1 - Initial Schema (2025-11-28)
**Status:** ✅ Completed

Created initial database schema:
- `players` table - player statistics
- `matches` table - match history
- `match_players` table - player performance per match
- Indexes for performance optimization

---

### Migration 2 - Diagnostic reports

Adds `diagnostic_reports`, with one JSON payload per report.

---

## 📝 How to Add a New Migration

### Step 1: Determine Migration Type

**Simple Migration (ALTER TABLE):**
- Adding new columns
- Renaming tables
- Adding indexes

**Complex Migration (table recreation):**
- Removing columns
- Changing column types
- Changing PRIMARY KEY
- Modifying constraints

### Step 2: Add Migration Code

Edit `stats/database.mjs` in the `initialize()` method:

```javascript
// ========================================
// MIGRATION 2: Your migration name
// ========================================
if (currentVersion < 2) {
    console.log('[DB] Running migration 2: Your migration name');

    // Your SQL changes here

    this.db.exec('UPDATE schema_version SET version = 2');
    currentVersion = 2;
    console.log('[DB] Migration 2 completed');
}
```

### Step 3: Test Migration

1. Backup your `stats.db` file
2. Restart the server
3. Check logs for migration messages
4. Verify data integrity

---

## 🛠️ Migration Examples

### Example 1: Add a New Column (Simple)

**Goal:** Add `shots` column to track shot attempts

```javascript
if (currentVersion < 2) {
    console.log('[DB] Running migration 2: Add shots column');

    this.db.exec(`
        ALTER TABLE players
        ADD COLUMN shots INTEGER DEFAULT 0
    `);

    this.db.exec('UPDATE schema_version SET version = 2');
    currentVersion = 2;
    console.log('[DB] Migration 2 completed');
}
```

---

### Example 2: Remove a Column (Complex)

**Goal:** Remove `old_column` from players table

```javascript
if (currentVersion < 3) {
    console.log('[DB] Running migration 3: Remove old_column');

    // Step 1: Create new table with desired structure
    this.db.exec(`
        CREATE TABLE players_new (
            auth TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            goals INTEGER DEFAULT 0,
            assists INTEGER DEFAULT 0,
            -- ... all columns EXCEPT old_column
            last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Step 2: Copy data (excluding old_column)
    this.db.exec(`
        INSERT INTO players_new (auth, name, goals, assists, ...)
        SELECT auth, name, goals, assists, ... FROM players
    `);

    // Step 3: Drop old table
    this.db.exec(`DROP TABLE players`);

    // Step 4: Rename new table
    this.db.exec(`ALTER TABLE players_new RENAME TO players`);

    // Step 5: Recreate indexes
    this.db.exec(`
        CREATE INDEX idx_players_goals ON players(goals DESC)
    `);

    this.db.exec('UPDATE schema_version SET version = 3');
    currentVersion = 3;
    console.log('[DB] Migration 3 completed');
}
```

---

### Example 3: Transform Data

**Goal:** Convert `minutes_played` from minutes to seconds

```javascript
if (currentVersion < 4) {
    console.log('[DB] Running migration 4: Convert minutes to seconds');

    // Multiply all existing values by 60
    this.db.exec(`
        UPDATE players
        SET minutes_played = minutes_played * 60
    `);

    // Optionally rename column for clarity
    this.db.exec(`
        CREATE TABLE players_new (
            auth TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            -- ... other columns
            seconds_played INTEGER DEFAULT 0,  -- renamed!
            -- ... remaining columns
        )
    `);

    this.db.exec(`
        INSERT INTO players_new (auth, name, ..., seconds_played, ...)
        SELECT auth, name, ..., minutes_played, ... FROM players
    `);

    this.db.exec(`DROP TABLE players`);
    this.db.exec(`ALTER TABLE players_new RENAME TO players`);

    this.db.exec('UPDATE schema_version SET version = 4');
    currentVersion = 4;
    console.log('[DB] Migration 4 completed');
}
```

---

### Example 4: Add New Table with Relations

**Goal:** Add `player_achievements` table

```javascript
if (currentVersion < 5) {
    console.log('[DB] Running migration 5: Add achievements table');

    this.db.exec(`
        CREATE TABLE player_achievements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_auth TEXT NOT NULL,
            achievement_type TEXT NOT NULL,
            achieved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            metadata TEXT,
            FOREIGN KEY (player_auth) REFERENCES players(auth) ON DELETE CASCADE
        )
    `);

    this.db.exec(`
        CREATE INDEX idx_achievements_player
        ON player_achievements(player_auth)
    `);

    this.db.exec('UPDATE schema_version SET version = 5');
    currentVersion = 5;
    console.log('[DB] Migration 5 completed');
}
```

---

## ⚠️ Best Practices

### DO ✅
- Always backup `stats.db` before testing migrations
- Test migrations on a copy of production data
- Use transactions for complex multi-step migrations
- Log migration start and completion
- Increment version number at the end
- Document what changed in this file

### DON'T ❌
- Never skip version numbers
- Never modify old migrations (they may have already run)
- Never use `CREATE TABLE IF NOT EXISTS` in migrations (defeats the purpose)
- Don't forget to recreate indexes after table recreation
- Don't assume migration order - always check `currentVersion`

---

## 🔄 Rolling Back Migrations

SQLite doesn't support automatic rollbacks. To revert:

1. **Option A:** Restore from backup
   ```bash
   cp stats.db.backup stats.db
   ```

2. **Option B:** Write reverse migration
   ```javascript
   // This is manual and error-prone!
   // Better to restore from backup
   ```

---

## 📦 Production Deployment

When deploying schema changes:

1. Backup production database
2. Stop the application
3. Deploy new code (includes migration)
4. Start the application (migration runs automatically)
5. Verify migration success in logs
6. Test critical functionality

---

## 🐛 Troubleshooting

**Migration doesn't run:**
- Check `SELECT * FROM schema_version` - what's the current version?
- Check if migration condition is correct (`if (currentVersion < X)`)

**Migration fails midway:**
- Restore from backup
- Fix migration code
- Try again

**Data loss after migration:**
- This shouldn't happen if you follow the examples
- Always test on a copy first!
- Restore from backup

---

**Last updated:** 2025-11-28
**Schema version:** 2
