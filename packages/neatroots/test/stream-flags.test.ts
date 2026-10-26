import fs from "node:fs";
import { setImmediate } from "node:timers/promises";
import { expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { batch, hex, s, span, tmpHome } from "./helpers.js";

it("reads the persisted projection without parsing attributes and uses the covering index", async () => {
  const home = tmpHome(), store = new Store(home);
  try {
    const traceId = hex(16), call = span({ traceId, name: "stream", kind: "llm", attrs: [s("neatlogs.stream.cancelled", true)] });
    store.ingest([batch([call])]);
    store.db.exec("DROP TRIGGER spans_stream_update");
    // Corrupt only this isolated fixture's raw JSON: projection reads must not evaluate it.
    store.db.prepare("UPDATE spans SET attributes = 'not json' WHERE trace_id = ?").run(traceId);
    expect(await store.cancelledSpanIds(traceId)).toEqual(new Set([call.spanId]));
    const plan = store.db.prepare("EXPLAIN QUERY PLAN SELECT span_id FROM spans WHERE trace_id = ? AND stream_cancelled = 1").all(traceId);
    expect(JSON.stringify(plan)).toContain("COVERING INDEX spans_stream_cancelled");
  } finally { store.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

it("backfills legacy rows over multiple turns and preserves a correction during the yield", async () => {
  const home = tmpHome(); let store = new Store(home);
  try {
    const traceId = hex(16);
    const calls = Array.from({ length: 40 }, () => span({ traceId, name: "stream", kind: "llm", attrs: [s("neatlogs.stream.cancelled", true)] }));
    store.ingest([batch(calls)]);
    const raw = store.getOtlpSpan(traceId, calls[0].spanId)!.span;
    store.db.exec("DROP TRIGGER spans_stream_insert; DROP TRIGGER spans_stream_update; DROP INDEX spans_stream_cancelled; ALTER TABLE spans DROP COLUMN stream_cancelled");
    store.close(); store = new Store(home);
    let yielded = false;
    const correction = setImmediate().then(() => {
      yielded = true;
      store.ingest([batch([{ ...calls[39], attributes: [s("neatlogs.span.kind", "LLM"), s("neatlogs.stream.cancelled", false)] }])]);
    });
    const flags = await store.cancelledSpanIds(traceId); await correction;
    expect(yielded).toBe(true);
    expect(flags.size).toBe(39); expect(flags.has(calls[39].spanId)).toBe(false);
    expect(store.getOtlpSpan(traceId, calls[0].spanId)!.span).toEqual(raw);
    expect(store.db.prepare("SELECT count(*) AS n FROM spans WHERE stream_cancelled IS NULL").get()).toEqual({ n: 0 });
  } finally { store.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

it("keeps projections current when an older writer replaces or updates a span", async () => {
  const home = tmpHome(), store = new Store(home);
  try {
    const traceId = hex(16), call = span({ traceId, name: "stream", kind: "llm" }); store.ingest([batch([call])]);
    const values = (v: boolean) => JSON.stringify([s("neatlogs.stream.cancelled", !v), s("neatlogs.stream.cancelled", v)]);
    store.db.prepare("UPDATE spans SET attributes = ? WHERE trace_id = ?").run(values(true), traceId);
    expect(await store.cancelledSpanIds(traceId)).toEqual(new Set([call.spanId]));
    // A pre-projection INSERT/REPLACE omits the new column (default NULL), so its trigger fills it.
    const row = store.db.prepare("SELECT * FROM spans WHERE trace_id = ?").get(traceId) as Record<string, unknown>;
    delete row.stream_cancelled; row.attributes = values(false);
    const columns = Object.keys(row);
    store.db.prepare(`INSERT OR REPLACE INTO spans (${columns.join(",")}) VALUES (${columns.map(c => `@${c}`).join(",")})`).run(row);
    expect(await store.cancelledSpanIds(traceId)).toEqual(new Set());
    store.deleteRun(traceId); expect(await store.cancelledSpanIds(traceId)).toEqual(new Set());
  } finally { store.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
