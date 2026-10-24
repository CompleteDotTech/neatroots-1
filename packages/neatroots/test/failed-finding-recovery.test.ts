import { afterEach, describe, expect, it } from "vitest";
import { parseChecks } from "../src/checks/registry.js";
import { batch, hex, llmSpan, makeRoots, markerSpan, mockLlm, span, toolSpan, until, type TestRoots } from "./helpers.js";

// A question whose model call errors (a malformed answer, say) records a "failed" finding, which the
// run page shows as "1 check could not run". When the same question later gets an answer on that
// run, the row is stale: it used to stay, so the page kept saying the check could not run (while
// its coverage line said every question was answered), and a later flag sat next to it.

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

type Answer = "error" | "no" | "yes";

/** A served neatroots with one question whose answer each call is decided by `answer(evidence)`. */
async function setup(scope: "trace" | "span", answer: (evidence: string) => Answer) {
  const llm = await mockLlm({});
  const tb = await makeRoots({ serve: true, llmUrl: llm.url });
  cleanup.push(async () => {
    await tb.close();
    await llm.close();
  });
  tb.roots.checks.save(
    parseChecks(`
- id: refund-claimed
  kind: yes_no
  scope: ${scope}
  title: Claimed a refund it did not make
  ask: Did the agent claim a refund it did not make?
  flag_at: 0.5
  evidence: { spans: { type: [${scope === "span" ? "tool" : "llm"}] } }
`).checks[0],
    "user",
  );
  const decisions = (tb.roots as unknown as { decisions: { decide: (e: string, q: { name: string }[], o?: unknown) => Promise<unknown> } }).decisions;
  const real = decisions.decide.bind(decisions);
  decisions.decide = async (evidence, questions, o) => {
    if (!questions.some((q) => q.name === "refund-claimed")) return real(evidence, questions, o);
    const a = answer(evidence);
    if (a === "error") throw new Error("the model's answer was not valid JSON");
    return { answers: { "refund-claimed": { probability: a === "yes" ? 0.95 : 0.05 } }, backend: "llm", model: "mock", latencyMs: 1 };
  };
  return tb;
}

async function finish(tb: TestRoots, t: string) {
  await until(() => tb.roots.store.getSummary(t), 15_000);
  await tb.roots.engine!.waitIdle(t, 10_000);
}

async function recheck(tb: TestRoots, t: string) {
  await tb.roots.engine!.recheck(t);
  await tb.roots.engine!.waitIdle(t, 10_000);
}

/** What the run page reads: this check's finding statuses, and the run's coverage. */
async function page(tb: TestRoots, t: string) {
  const r = await fetch(`${tb.url}/api/runs/${t}`, { headers: { origin: tb.url.replace("127.0.0.1", "localhost") } });
  const d = (await r.json()) as { findings: { check_id: string; status: string; detail: { span_id?: string | null } }[]; coverage: { state: string; failed: number } };
  return { statuses: d.findings.filter((f) => f.check_id === "refund-claimed").map((f) => f.status), findings: d.findings, coverage: d.coverage };
}

describe("a question that could not run, then did", () => {
  it("drops the 'could not run' row once the question is answered, and a later flag stands alone", async () => {
    let next: Answer = "error";
    const tb = await setup("trace", () => next);
    const t = hex(16);
    const r = hex(8);
    tb.roots.ingest([batch([llmSpan(t, r, { user: "refund order 1001", out: "Refunded." }), span({ traceId: t, spanId: r, name: "agent", kind: "workflow" }), markerSpan(t, r)])]);
    await finish(tb, t);
    expect((await page(tb, t)).statuses).toEqual(["failed"]);

    next = "no";
    await recheck(tb, t);
    const clean = await page(tb, t);
    expect(clean.statuses).toEqual([]); // was ["failed"], with coverage already "done"
    expect(clean.coverage).toMatchObject({ state: "done", failed: 0 });

    next = "error";
    await recheck(tb, t);
    expect((await page(tb, t)).statuses).toEqual(["failed"]);
    next = "yes";
    await recheck(tb, t);
    expect((await page(tb, t)).statuses).toEqual(["raised"]); // was ["failed", "raised"]
  });

  it("keeps a span's row while that span is still unjudged, and drops it once it is", async () => {
    let failA = true;
    const tb = await setup("span", (evidence) => (evidence.includes("lookup_a") && failA ? "error" : "no"));
    const t = hex(16);
    const r = hex(8);
    // B first: a span's evidence includes the spans before it, so only A's own call mentions lookup_a.
    const b = toolSpan(t, r, "lookup_b", '{"order":"1002"}', '{"ok":true}');
    const a = toolSpan(t, r, "lookup_a", '{"order":"1001"}', '{"ok":true}');
    tb.roots.ingest([batch([b, a, span({ traceId: t, spanId: r, name: "agent", kind: "workflow" }), markerSpan(t, r)])]);
    await finish(tb, t);
    // span A could not be judged; span B was answered, which must not clear A's row
    const first = await page(tb, t);
    expect(first.findings.filter((f) => f.status === "failed").map((f) => f.detail.span_id)).toEqual([a.spanId]);

    failA = false;
    await recheck(tb, t);
    expect((await page(tb, t)).statuses).toEqual([]);
  });
});
