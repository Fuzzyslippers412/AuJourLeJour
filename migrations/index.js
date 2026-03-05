function ensureMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
}

function migrationAlreadyApplied(db, id) {
  const row = db
    .prepare("SELECT id FROM schema_migrations WHERE id = ?")
    .get(id);
  return !!row;
}

function markMigrationApplied(db, id, nowIso) {
  db.prepare(
    "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)"
  ).run(id, nowIso());
}

function runSingleMigration(db, migration, nowIso) {
  if (migrationAlreadyApplied(db, migration.id)) return false;
  const tx = db.transaction(() => {
    migration.up(db);
    markMigrationApplied(db, migration.id, nowIso);
  });
  tx();
  return true;
}

function runMigrations(db, nowIso) {
  ensureMigrationTable(db);

  const migrations = [
    {
      id: "001-assistant-tables",
      up(innerDb) {
        innerDb.exec(`
          CREATE TABLE IF NOT EXISTS agent_command_log (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            user_text TEXT,
            kind TEXT NOT NULL,
            summary TEXT,
            payload TEXT,
            result TEXT,
            status TEXT NOT NULL
          );

          CREATE INDEX IF NOT EXISTS idx_agent_log_created
          ON agent_command_log (created_at);

          CREATE TABLE IF NOT EXISTS assistant_chat (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            role TEXT NOT NULL,
            text TEXT NOT NULL,
            meta TEXT
          );

          CREATE INDEX IF NOT EXISTS idx_assistant_chat_created
          ON assistant_chat (created_at);
        `);
      },
    },
    {
      id: "002-shares-table-index",
      up(innerDb) {
        innerDb.exec(`
          CREATE INDEX IF NOT EXISTS idx_shares_updated
          ON shares (updated_at);
        `);
      },
    },
    {
      id: "003-oauth-device-session-index",
      up(innerDb) {
        innerDb.exec(`
          CREATE INDEX IF NOT EXISTS idx_oauth_sessions_status
          ON oauth_device_sessions (provider, status, created_at);
        `);
      },
    },
  ];

  const applied = [];
  for (const migration of migrations) {
    const changed = runSingleMigration(db, migration, nowIso);
    if (changed) applied.push(migration.id);
  }
  return applied;
}

module.exports = {
  runMigrations,
};
