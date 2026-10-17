import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildView } from "../src/semantics/view.js";
import { loadTrace } from "../src/engine/trace.js";
import { evaluateRule } from "../src/checks/rules.js";
import { parseChecks } from "../src/checks/registry.js";
import { RuleSpec, type RuleCheck } from "../src/checks/types.js";
import { batch, closeTrackedStores, s, span, tmpHome, trackedStore } from "./helpers.js";

const homes: string[] = [];
afterEach(() => { closeTrackedStores(); for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true }); });
const check = parseChecks(fs.readFileSync(new URL("../library/rules.yaml", import.meta.url), "utf8")).checks.find((c) => c.id === "cache-not-reused") as RuleCheck;
function call(read?: number, write?: number, model = "claude") {
  return span({ traceId: "a".repeat(32), kind: "llm", name: "chat", attrs: [s("neatlogs.llm.model_name", model), s("neatlogs.llm.provider", "anthropic"),
    ...(read === undefined ? [] : [s("neatlogs.llm.token_count.cache_read", read)]),
    ...(write === undefined ? [] : [s("neatlogs.llm.token_count.cache_write", write)])] });
}
function evaluate(calls: ReturnType<typeof call>[]) {
  const home = tmpHome(); homes.push(home);
  const store = trackedStore(path.join(home, "data"));
  store.ingest([batch(calls)]);
  return { hit: evaluateRule(check, loadTrace(store, "a".repeat(32)), false), store };
}
it("fires on later cache-busting calls, preserves raw attributes and propagates normalized counts", () => {
  const calls = [call(0, 100), call(0, 100), call(0, 100)];
  const { hit, store } = evaluate([...calls].reverse());
  expect(hit?.evidenceSpanIds).toEqual(calls.slice(1).map((c) => c.spanId));
  expect(hit?.params).toEqual({ cache_write: "200", cache_read: "0" });
  expect(loadTrace(store, calls[0].traceId).spans[1].cacheWriteTokens).toBe(100);
  expect(store.getOtlpSpan(calls[0].traceId, calls[0].spanId)?.span.attributes).toEqual(calls[0].attributes);
});
it("keeps healthy, uncached, read-only OpenAI and first-call warmup quiet", () => {
  for (const calls of [
    [call(0, 66786), call(500000, 0), call(557791, 0)],
    [call(), call(), call()],
    [call(4096), call(4096), call(4096)],
    [call(0, 100000), call(10, 0), call(10, 0)],
    [call(0, 100), call(0, 100)],
    [call(0, 100), call(100, 100), call(100, 100)],
  ]) expect(evaluate(calls).hit).toBeNull();
});
it("requires explicit counts and excludes missing reads from evidence", () => {
  const calls = [call(0, 10), call(undefined, 10000), call(0, 10), call(0, 10)];
  expect(evaluate(calls).hit?.evidenceSpanIds).toEqual(calls.slice(2).map((c) => c.spanId));
  expect(evaluate([call(0, 10), call(), call(0, 10)]).hit).toBeNull();
});
it("isolates model warmups and cannot hide cache busting behind another model's reads", () => {
  const a = [call(0, 10, "a"), call(0, 10, "a"), call(0, 10, "a")];
  const b = [call(1000, 0, "b"), call(1000, 0, "b"), call(1000, 0, "b")];
  expect(evaluate([...a, ...b]).hit?.evidenceSpanIds).toEqual(a.slice(1).map((c) => c.spanId));
  expect(evaluate([call(0, 10, "a"), call(0, 10, "b"), call(0, 10, "c")]).hit).toBeNull();
});
it("orders equal start times by span ID regardless of arrival", () => {
  const calls = [call(0, 10), call(0, 10), call(0, 10)];
  calls.forEach((c, i) => { c.startTimeUnixNano = calls[0].startTimeUnixNano; c.spanId = String(i + 1).padStart(16, "0"); });
  expect(evaluate([calls[2], calls[0], calls[1]]).hit?.evidenceSpanIds).toEqual(calls.slice(1).map((c) => c.spanId));
});
it("normalizes public aliases without changing token totals", () => {
  for (const [read, write] of [
    ["gen_ai.usage.cache_read.input_tokens", "gen_ai.usage.cache_creation.input_tokens"],
    ["gen_ai.usage.cache_read_input_tokens", "gen_ai.usage.cache_creation_input_tokens"],
    ["gen_ai.usage.cache_read_input_tokens", "gen_ai.usage.cache_write_input_tokens"],
  ]) {
    const c = call(); c.attributes.push(s(read, "12"), s(write, 23), s("neatlogs.llm.token_count.prompt", 100), s("neatlogs.llm.token_count.completion", 2));
    expect(buildView(c, [])).toMatchObject({ cacheReadTokens: 12, cacheWriteTokens: 23, promptTokens: 100, totalTokens: 102 });
    c.attributes.push(s("neatlogs.llm.token_count.cache_read", 0));
    expect(buildView(c, []).cacheReadTokens).toBe(0);
  }
});
it("rejects invalid counts and validates the rule configuration", () => {
  for (const value of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, true, "-1", "", "   ", "NaN", "1.5"]) {
    const c = call(); c.attributes.push(s("neatlogs.llm.token_count.cache_read", value));
    expect(buildView(c, []).cacheReadTokens).toBeUndefined();
  }
  expect(RuleSpec.parse({ type: "cache_reuse" })).toEqual({ type: "cache_reuse", min_calls: 3 });
  for (const min_calls of [0, 2, 3.5]) expect(RuleSpec.safeParse({ type: "cache_reuse", min_calls }).success).toBe(false);
});

it("keeps providers separate even when model names match", () => {
  const calls = [call(0, 10), call(0, 10), call(0, 10)];
  calls[2].attributes = calls[2].attributes.filter((a) => a.key !== "neatlogs.llm.provider");
  calls[2].attributes.push(s("neatlogs.llm.provider", "bedrock"));
  expect(evaluate(calls).hit).toBeNull();
});
