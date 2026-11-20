// Catalog tables (DESIGN §4.1), the S1 subset. DDL only; no row mutation lives here.
import type { SqlDriver } from "./driver.ts";
import { migrateCollectionIndexes } from "./search-index.ts";

export const SCHEMA_VERSION = 4;

export function migrate(db: SqlDriver): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Ledger and operations (content-free: ids, ints, enums, 64-hex hashes)
CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, principal TEXT NOT NULL, client TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS values_(hash TEXT PRIMARY KEY, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS undo(event_seq INTEGER PRIMARY KEY REFERENCES events(seq), inverse_op TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY, opId TEXT NOT NULL, step TEXT NOT NULL, target TEXT NOT NULL, idempotencyKey TEXT NOT NULL UNIQUE, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, lastError TEXT, completedAt TEXT, nextAttemptAt TEXT);
CREATE TABLE IF NOT EXISTS authz_events(seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, kind TEXT NOT NULL, principal TEXT, payload TEXT NOT NULL, epoch INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS approvals(receiptId TEXT PRIMARY KEY, actionKind TEXT NOT NULL, actionHash TEXT NOT NULL, evidenceHash TEXT NOT NULL, principal TEXT NOT NULL, credentialId TEXT NOT NULL, issuedAt TEXT NOT NULL, expiresAt TEXT NOT NULL, usedAt TEXT, serverSig TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS policy_acceptances(epoch INTEGER PRIMARY KEY, policyHash TEXT NOT NULL, receiptId TEXT NOT NULL, sig TEXT NOT NULL, acceptedAt TEXT NOT NULL);
-- Archive
CREATE TABLE IF NOT EXISTS collections(collectionId TEXT PRIMARY KEY, class TEXT NOT NULL, store_ok INTEGER NOT NULL DEFAULT 1, clients_ok TEXT NOT NULL DEFAULT '[]', model_processing INTEGER NOT NULL DEFAULT 0, decision_row TEXT, binary INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS idempotency(key_h TEXT NOT NULL, principal TEXT NOT NULL, noteId TEXT NOT NULL, ver INTEGER NOT NULL, sha256 TEXT NOT NULL, createdAt TEXT NOT NULL, PRIMARY KEY(key_h, principal));
CREATE TABLE IF NOT EXISTS multipart_pushes(pushId TEXT PRIMARY KEY, principal TEXT NOT NULL, grant_h TEXT NOT NULL, collectionId TEXT NOT NULL, createdAt TEXT NOT NULL, expiresAt TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open');
CREATE TABLE IF NOT EXISTS text_pushes(pushId TEXT PRIMARY KEY, principal TEXT NOT NULL, grant_h TEXT NOT NULL, snapshot_h TEXT NOT NULL, manifest_h TEXT NOT NULL, folderId TEXT NOT NULL, collectionId TEXT NOT NULL, createdAt TEXT NOT NULL, expiresAt TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open', UNIQUE(principal, grant_h, snapshot_h));
CREATE TABLE IF NOT EXISTS text_push_items(pushId TEXT NOT NULL REFERENCES text_pushes(pushId), n INTEGER NOT NULL, sha256 TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'missing', result_h TEXT, PRIMARY KEY(pushId,n));
CREATE TABLE IF NOT EXISTS folders(folderId TEXT PRIMARY KEY, device TEXT NOT NULL, volumeSerial TEXT NOT NULL, rootFileId TEXT NOT NULL, display_path_h TEXT NOT NULL, owner_principal TEXT NOT NULL, collectionId TEXT NOT NULL REFERENCES collections(collectionId), orrery_registered INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS notes(noteId TEXT PRIMARY KEY, collectionId TEXT NOT NULL REFERENCES collections(collectionId), folderId TEXT, currentVer INTEGER NOT NULL, title_h TEXT, kind TEXT NOT NULL, status TEXT NOT NULL, supersededBy TEXT, privacy_class TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS versions(noteId TEXT NOT NULL REFERENCES notes(noteId), ver INTEGER NOT NULL, parentVer INTEGER, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, origin TEXT NOT NULL, privacy_class TEXT NOT NULL, role TEXT NOT NULL, vstatus TEXT NOT NULL, authoredAt TEXT, observedMtime TEXT, capturedAt TEXT NOT NULL, publishedAt TEXT NOT NULL, lastVerifiedAt TEXT NOT NULL, custody TEXT NOT NULL, localState TEXT NOT NULL DEFAULT 'present', held INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(noteId, ver));
-- One row per member of the version's privacy-class set (S1c A1/A2): a reader needs every member.
CREATE TABLE IF NOT EXISTS version_classes(noteId TEXT NOT NULL, ver INTEGER NOT NULL, class TEXT NOT NULL, PRIMARY KEY(noteId, ver, class));
CREATE INDEX IF NOT EXISTS versions_sha ON versions(sha256);
CREATE TABLE IF NOT EXISTS blob_refs(sha256 TEXT PRIMARY KEY, refcount INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'live', pendingRefs TEXT NOT NULL DEFAULT '[]');
-- owner IS NULL: the real alias. owner = principal: a shadow alias in that saver's namespace, used when a note the saver cannot see holds the path (S1c B2).
CREATE TABLE IF NOT EXISTS aliases(id INTEGER PRIMARY KEY, collectionId TEXT NOT NULL, folderId TEXT, path_h TEXT NOT NULL, noteId TEXT NOT NULL REFERENCES notes(noteId), valid_from TEXT NOT NULL, valid_to TEXT, owner TEXT);
CREATE INDEX IF NOT EXISTS aliases_lookup ON aliases(collectionId, path_h, valid_to);
CREATE TABLE IF NOT EXISTS designations(scope TEXT NOT NULL, purpose TEXT NOT NULL, noteId TEXT NOT NULL, ver INTEGER NOT NULL, designatedBy TEXT NOT NULL, receiptId TEXT NOT NULL, at TEXT NOT NULL, supersededBy TEXT);
CREATE TABLE IF NOT EXISTS principals(id TEXT PRIMARY KEY, email TEXT NOT NULL, status TEXT NOT NULL, allowed_classes TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tokens(hash TEXT PRIMARY KEY, principal TEXT NOT NULL REFERENCES principals(id), kind TEXT NOT NULL, scopes TEXT NOT NULL, client_class TEXT NOT NULL, issuedAt TEXT NOT NULL, expiresAt TEXT NOT NULL, revokedAt TEXT, collection_ids TEXT);
-- Organization
CREATE TABLE IF NOT EXISTS tags(noteId TEXT NOT NULL, tag_h TEXT NOT NULL, origin TEXT NOT NULL, playbookVer TEXT, state TEXT NOT NULL, PRIMARY KEY(noteId, tag_h));
CREATE TABLE IF NOT EXISTS edges(src TEXT NOT NULL, dst TEXT NOT NULL, type TEXT NOT NULL, origin TEXT NOT NULL, confidence REAL NOT NULL, state TEXT NOT NULL, evidenceCite TEXT, PRIMARY KEY(src, dst, type));
-- Overrides, usage
CREATE TABLE IF NOT EXISTS overrides(id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL, topic_h TEXT, scope TEXT NOT NULL, principal TEXT NOT NULL, client TEXT NOT NULL, receiptId TEXT, state TEXT NOT NULL, createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS query_log(queryId TEXT PRIMARY KEY, principal TEXT NOT NULL, client TEXT NOT NULL, q_h TEXT NOT NULL, top TEXT NOT NULL, generation INTEGER NOT NULL, ts TEXT NOT NULL, interactive INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, ts TEXT NOT NULL, principal TEXT NOT NULL, client TEXT NOT NULL, tool TEXT NOT NULL, ids TEXT NOT NULL, status TEXT NOT NULL, ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reads(id INTEGER PRIMARY KEY, principal TEXT NOT NULL, grant_h TEXT, noteId TEXT NOT NULL, ver INTEGER NOT NULL, privacy_class TEXT NOT NULL, viaQueryId TEXT, ts TEXT NOT NULL);
-- Append-only correction content and state events. Text remains in purgeable values_.
CREATE TABLE IF NOT EXISTS corrections(id TEXT PRIMARY KEY, eventSeq INTEGER NOT NULL UNIQUE REFERENCES events(seq), author TEXT NOT NULL, client TEXT NOT NULL, scopeId TEXT NOT NULL, targetNoteId TEXT NOT NULL, targetVer INTEGER NOT NULL, targetSha256 TEXT NOT NULL, topic_h TEXT NOT NULL, topicKey_h TEXT NOT NULL, statement_h TEXT NOT NULL, evidenceCite_h TEXT NOT NULL, supersedes TEXT REFERENCES corrections(id), caseId TEXT UNIQUE REFERENCES cases(caseId), createdAt TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS corrections_partition ON corrections(scopeId,targetNoteId,targetVer,author,topicKey_h,eventSeq);
CREATE TABLE IF NOT EXISTS correction_states(seq INTEGER PRIMARY KEY REFERENCES events(seq), correctionId TEXT NOT NULL REFERENCES corrections(id), state TEXT NOT NULL CHECK(state IN ('applied','reverted')), priorSeq INTEGER NOT NULL, receiptId TEXT REFERENCES approvals(receiptId), verification_h TEXT, createdAt TEXT NOT NULL);
-- Learning
CREATE TABLE IF NOT EXISTS signals(signalId TEXT PRIMARY KEY, kind TEXT NOT NULL, principal TEXT NOT NULL, client TEXT NOT NULL, scopeId TEXT NOT NULL, target TEXT NOT NULL, queryId TEXT, q_h TEXT, strength TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0, receiptId TEXT, ts TEXT NOT NULL, interactive INTEGER NOT NULL, status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cases(caseId TEXT PRIMARY KEY, capability TEXT NOT NULL, scopeId TEXT NOT NULL, privacy TEXT NOT NULL, groupKey TEXT NOT NULL, lineageKey TEXT NOT NULL, inputRef TEXT NOT NULL, frozenFeatures TEXT NOT NULL, expected TEXT NOT NULL, split TEXT NOT NULL, sourceSignals TEXT NOT NULL, author TEXT NOT NULL, client TEXT NOT NULL, receiptId TEXT, status TEXT NOT NULL, createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS playbooks(hash TEXT PRIMARY KEY, capability TEXT NOT NULL, body TEXT NOT NULL, createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS candidates(candidateId TEXT PRIMARY KEY, capability TEXT NOT NULL, scopeId TEXT NOT NULL, privacy TEXT NOT NULL, playbookHash TEXT NOT NULL REFERENCES playbooks(hash), parentHash TEXT, generator TEXT NOT NULL, targetGroups TEXT NOT NULL, state TEXT NOT NULL, verdict TEXT, report TEXT, createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS champions(id INTEGER PRIMARY KEY, capability TEXT NOT NULL, scopeId TEXT NOT NULL, privacy TEXT NOT NULL, playbookHash TEXT NOT NULL REFERENCES playbooks(hash), candidateId TEXT, receiptId TEXT, promotedAt TEXT NOT NULL, revokedAt TEXT, frozenBaseline INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS evolution(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, capability TEXT NOT NULL, scopeId TEXT NOT NULL, privacy TEXT NOT NULL, candidateId TEXT, playbookHash TEXT, metricDelta TEXT, ts TEXT NOT NULL);
-- A replay record binds a grade to a real replay (S1c C1): the report hash, the candidate playbook, the ledger generation it ran at and its own event seq.
CREATE TABLE IF NOT EXISTS replays(id INTEGER PRIMARY KEY, reportHash TEXT NOT NULL UNIQUE, playbookHash TEXT NOT NULL, capability TEXT NOT NULL, scopeId TEXT NOT NULL, privacy TEXT NOT NULL, generation INTEGER NOT NULL, seq INTEGER NOT NULL, lookSpent INTEGER NOT NULL, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS holdout_looks(id INTEGER PRIMARY KEY, capability TEXT NOT NULL, scopeId TEXT NOT NULL, privacy TEXT NOT NULL, candidateId TEXT NOT NULL, isoWeek TEXT NOT NULL, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ladder_state(capability TEXT NOT NULL, scopeId TEXT NOT NULL, rung INTEGER NOT NULL, streak INTEGER NOT NULL, PRIMARY KEY(capability, scopeId));
-- Evidence
CREATE TABLE IF NOT EXISTS evidence_snapshots(sequence INTEGER PRIMARY KEY, snapshotId TEXT NOT NULL UNIQUE, generatedAt TEXT NOT NULL, digest TEXT NOT NULL, contentDigest TEXT NOT NULL, body TEXT NOT NULL, sig TEXT NOT NULL, keyId TEXT NOT NULL);
-- Search: chunks + FTS5 external content
-- One FTS index per privacy class (fts_<class>), created lazily by the indexer, so BM25 statistics never
-- depend on notes the caller cannot see.
CREATE TABLE IF NOT EXISTS chunks(rowid INTEGER PRIMARY KEY, noteId TEXT NOT NULL, ver INTEGER NOT NULL, n INTEGER NOT NULL, privacy_class TEXT NOT NULL, title TEXT NOT NULL, headings TEXT NOT NULL, tags TEXT NOT NULL, body TEXT NOT NULL, path TEXT NOT NULL, lineFrom INTEGER NOT NULL, lineTo INTEGER NOT NULL, UNIQUE(noteId, ver, n));
CREATE INDEX IF NOT EXISTS chunks_class ON chunks(privacy_class);
`);
  // Additive v3 migration. Legacy rows retain a NULL namespace and remain resolved
  // through their owning note's folder. No catalog content is rewritten by migration.
  if (!db.all<{name:string}>("PRAGMA table_info(aliases)").some(c=>c.name==="folderId")) db.exec("ALTER TABLE aliases ADD COLUMN folderId TEXT");
  // NULL preserves explicit legacy grants; secure enrollment always supplies an exact collection list.
  if (!db.all<{name:string}>("PRAGMA table_info(tokens)").some(c=>c.name==="collection_ids")) db.exec("ALTER TABLE tokens ADD COLUMN collection_ids TEXT");
  if (Number(db.get<{ value: string }>("SELECT value FROM meta WHERE key='schema_version'")?.value ?? "0") < 4) migrateCollectionIndexes(db);
  db.exec("DROP INDEX IF EXISTS aliases_live; CREATE UNIQUE INDEX IF NOT EXISTS aliases_folder_live ON aliases(collectionId,COALESCE(folderId,''),path_h,COALESCE(owner,'')) WHERE valid_to IS NULL;");
  db.run("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
  db.run("UPDATE meta SET value=? WHERE key='schema_version' AND CAST(value AS INTEGER) < ?", [String(SCHEMA_VERSION), SCHEMA_VERSION]);
  db.run("INSERT OR IGNORE INTO meta(key, value) VALUES ('min_policy_epoch', '0')");
  db.run("INSERT OR IGNORE INTO meta(key, value) VALUES ('setup_mode', '0')"); // a new catalog starts SEALED
}
