#!/usr/bin/env node

/**
 * Backfill usage_history.api_key_id from call_logs
 * 
 * This script fixes historical usage_history rows that are missing api_key_id
 * by cross-referencing with call_logs which has correct API key attribution.
 * 
 * Usage:
 *   node scripts/backfill-usage-apikey.js [--dry-run] [--db-path /path/to/omniroute.db]
 * 
 * Options:
 *   --dry-run    Show what would be updated without making changes
 *   --db-path    Path to the OmniRoute SQLite database (default: auto-detect)
 */

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

// Parse CLI args
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dbPathIdx = args.indexOf("--db-path");
let dbPath = dbPathIdx >= 0 && args[dbPathIdx + 1] ? args[dbPathIdx + 1] : null;

// Auto-detect DB path
if (!dbPath) {
  const homeDir = require("os").homedir();
  const candidates = [
    // Standard OmniRoute data paths
    path.join(__dirname, "..", "data", "storage.sqlite"),
    path.join(__dirname, "..", ".data", "storage.sqlite"),
    path.join(homeDir, ".omniroute", "storage.sqlite"),
    path.join(process.cwd(), "data", "storage.sqlite"),
    path.join(process.cwd(), ".data", "storage.sqlite"),
    // Legacy names
    path.join(__dirname, "..", "data", "omniroute.db"),
    path.join(process.cwd(), "data", "omniroute.db"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      dbPath = candidate;
      break;
    }
  }
}

if (!dbPath || !fs.existsSync(dbPath)) {
  console.error("❌ Could not find OmniRoute database. Use --db-path to specify location.");
  process.exit(1);
}

console.log(`📂 Database: ${dbPath}`);
console.log(`🔧 Mode: ${dryRun ? "DRY RUN (no changes)" : "LIVE (will update rows)"}\n`);

const db = new Database(dbPath);

// Enable WAL mode for better concurrent access
db.pragma("journal_mode = WAL");

// Step 1: Check current state
const totalUsageRows = db.prepare("SELECT COUNT(*) as cnt FROM usage_history").get();
const missingKeyRows = db.prepare(
  "SELECT COUNT(*) as cnt FROM usage_history WHERE (api_key_id IS NULL OR api_key_id = '')"
).get();
const withKeyRows = db.prepare(
  "SELECT COUNT(*) as cnt FROM usage_history WHERE api_key_id IS NOT NULL AND api_key_id != ''"
).get();

console.log("📊 Current State:");
console.log(`   Total usage_history rows:  ${totalUsageRows.cnt}`);
console.log(`   With api_key_id:           ${withKeyRows.cnt}`);
console.log(`   Missing api_key_id:        ${missingKeyRows.cnt}`);
console.log();

if (missingKeyRows.cnt === 0) {
  console.log("✅ All usage_history rows already have api_key_id. Nothing to backfill.");
  db.close();
  process.exit(0);
}

// Step 2: Check call_logs for available attribution data
const callLogKeys = db.prepare(`
  SELECT api_key_id, api_key_name, COUNT(*) as cnt
  FROM call_logs
  WHERE api_key_id IS NOT NULL AND api_key_id != ''
  GROUP BY api_key_id, api_key_name
  ORDER BY cnt DESC
`).all();

console.log("🔑 API Keys Found in call_logs:");
for (const row of callLogKeys) {
  console.log(`   ${row.api_key_name || "unnamed"} (${row.api_key_id}): ${row.cnt} entries`);
}
console.log();

// Step 3: Backfill using timestamp + model + provider matching
// Strategy: For each usage_history row missing api_key_id, find the closest
// call_log entry with matching model/provider within a small time window.

const backfillQuery = db.prepare(`
  UPDATE usage_history
  SET 
    api_key_id = (
      SELECT cl.api_key_id 
      FROM call_logs cl 
      WHERE cl.api_key_id IS NOT NULL 
        AND cl.api_key_id != ''
        AND cl.model = usage_history.model
        AND ABS(
          CAST(strftime('%s', cl.timestamp) AS INTEGER) - 
          CAST(strftime('%s', usage_history.timestamp) AS INTEGER)
        ) <= 5
      ORDER BY ABS(
        CAST(strftime('%s', cl.timestamp) AS INTEGER) - 
        CAST(strftime('%s', usage_history.timestamp) AS INTEGER)
      ) ASC
      LIMIT 1
    ),
    api_key_name = (
      SELECT cl.api_key_name 
      FROM call_logs cl 
      WHERE cl.api_key_id IS NOT NULL 
        AND cl.api_key_id != ''
        AND cl.model = usage_history.model
        AND ABS(
          CAST(strftime('%s', cl.timestamp) AS INTEGER) - 
          CAST(strftime('%s', usage_history.timestamp) AS INTEGER)
        ) <= 5
      ORDER BY ABS(
        CAST(strftime('%s', cl.timestamp) AS INTEGER) - 
        CAST(strftime('%s', usage_history.timestamp) AS INTEGER)
      ) ASC
      LIMIT 1
    )
  WHERE (api_key_id IS NULL OR api_key_id = '')
    AND EXISTS (
      SELECT 1 
      FROM call_logs cl 
      WHERE cl.api_key_id IS NOT NULL 
        AND cl.api_key_id != ''
        AND cl.model = usage_history.model
        AND ABS(
          CAST(strftime('%s', cl.timestamp) AS INTEGER) - 
          CAST(strftime('%s', usage_history.timestamp) AS INTEGER)
        ) <= 5
    )
`);

if (dryRun) {
  // In dry run mode, count how many rows would be affected
  const wouldMatch = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM usage_history
    WHERE (api_key_id IS NULL OR api_key_id = '')
      AND EXISTS (
        SELECT 1 
        FROM call_logs cl 
        WHERE cl.api_key_id IS NOT NULL 
          AND cl.api_key_id != ''
          AND cl.model = usage_history.model
          AND ABS(
            CAST(strftime('%s', cl.timestamp) AS INTEGER) - 
            CAST(strftime('%s', usage_history.timestamp) AS INTEGER)
          ) <= 5
      )
  `).get();

  console.log(`🔍 DRY RUN: Would backfill ${wouldMatch.cnt} of ${missingKeyRows.cnt} missing rows`);
  console.log(`   (${missingKeyRows.cnt - wouldMatch.cnt} rows have no matching call_log entry)`);
} else {
  console.log("⏳ Running backfill...");
  const startTime = Date.now();
  
  const result = backfillQuery.run();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  
  console.log(`✅ Backfill complete in ${elapsed}s`);
  console.log(`   Rows updated: ${result.changes}`);
  
  // Verify
  const afterMissing = db.prepare(
    "SELECT COUNT(*) as cnt FROM usage_history WHERE (api_key_id IS NULL OR api_key_id = '')"
  ).get();
  const afterWith = db.prepare(
    "SELECT COUNT(*) as cnt FROM usage_history WHERE api_key_id IS NOT NULL AND api_key_id != ''"
  ).get();
  
  console.log("\n📊 After Backfill:");
  console.log(`   With api_key_id:     ${afterWith.cnt}`);
  console.log(`   Still missing:       ${afterMissing.cnt}`);
  
  // Show per-key breakdown
  const keyBreakdown = db.prepare(`
    SELECT api_key_id, api_key_name, COUNT(*) as cnt
    FROM usage_history
    WHERE api_key_id IS NOT NULL AND api_key_id != ''
    GROUP BY api_key_id, api_key_name
    ORDER BY cnt DESC
  `).all();
  
  console.log("\n🔑 Per-Key Usage Breakdown (after backfill):");
  for (const row of keyBreakdown) {
    console.log(`   ${row.api_key_name || "unnamed"} (${row.api_key_id}): ${row.cnt} requests`);
  }
}

db.close();
console.log("\n🏁 Done.");
