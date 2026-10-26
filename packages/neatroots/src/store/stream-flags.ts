import { setImmediate } from "node:timers/promises";
import type Database from "better-sqlite3";

const FLAG = `COALESCE((SELECT json_type(a.value, '$.value.boolValue') = 'true'
  FROM json_each(attributes) AS a WHERE json_extract(a.value, '$.key') = 'neatlogs.stream.cancelled'
  ORDER BY CAST(a.key AS INTEGER) DESC LIMIT 1), 0)`;

/** Indexed cancellation flags, with yielding backfill for stores written before this projection. */
export class StreamFlags {
  /** Add the projection without scanning payloads; triggers also support older writers. */
  constructor(private readonly db: Database.Database) {
    const columns = db.prepare("PRAGMA table_info(spans)").all() as { name: string }[];
    if (!columns.some(c => c.name === "stream_cancelled")) db.exec("ALTER TABLE spans ADD COLUMN stream_cancelled INTEGER");
    db.exec(`CREATE INDEX IF NOT EXISTS spans_stream_cancelled ON spans(trace_id, stream_cancelled, span_id);
      CREATE TRIGGER IF NOT EXISTS spans_stream_insert AFTER INSERT ON spans
      WHEN NEW.stream_cancelled IS NULL BEGIN
        UPDATE spans SET stream_cancelled = ${FLAG} WHERE trace_id = NEW.trace_id AND span_id = NEW.span_id;
      END;
      CREATE TRIGGER IF NOT EXISTS spans_stream_update AFTER UPDATE OF attributes ON spans BEGIN
        UPDATE spans SET stream_cancelled = ${FLAG} WHERE trace_id = NEW.trace_id AND span_id = NEW.span_id;
      END;`);
  }

  /** Backfill at most 16 old rows per turn; completed reads use only the compact index. */
  async cancelled(traceId: string): Promise<Set<string>> {
    const pending = this.db.prepare("SELECT span_id FROM spans WHERE trace_id = ? AND stream_cancelled IS NULL LIMIT 16");
    const update = this.db.prepare(`UPDATE spans SET stream_cancelled = ${FLAG}
      WHERE trace_id = ? AND span_id = ? AND stream_cancelled IS NULL`);
    const fill = this.db.transaction((rows: { span_id: string }[]) => {
      for (const row of rows) update.run(traceId, row.span_id);
    });
    for (;;) {
      const rows = pending.all(traceId) as { span_id: string }[];
      if (!rows.length) break;
      fill(rows);
      await setImmediate();
    }
    const rows = this.db.prepare("SELECT span_id FROM spans WHERE trace_id = ? AND stream_cancelled = 1").all(traceId) as { span_id: string }[];
    return new Set(rows.map(row => row.span_id));
  }
}
