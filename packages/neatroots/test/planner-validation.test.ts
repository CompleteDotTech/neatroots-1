import { afterEach, expect, it, vi } from "vitest";
import { batch, hex, llmSpan, makeRoots, mockLlm, toolSpan } from "./helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const question = { id: "refund-policy", ask: "Did the agent violate the refund policy?", scope: "trace" };
async function start(plannerJson: unknown) {
  const llm = await mockLlm({ plannerJson });
  const t = await makeRoots({ llmUrl: llm.url });
  cleanup.push(async () => { await t.close(); await llm.close(); });
  const save = vi.spyOn(t.roots.checks, "save");
  const insertPlan = vi.spyOn(t.roots.store, "insertPlan");
  const traceId = hex(16), root = hex(8);
  t.roots.ingest([batch([llmSpan(traceId, root, { user: "Refund order 4512", tools: ["lookup_order"] })])]);
  expect(await t.roots.engine!.waitIdle(traceId, 5000)).toBe(true);
  const plan = t.roots.store.getPlan(t.roots.store.getRun(traceId)!.plan_id!)!;
  return { t, llm, traceId, root, plan, save, insertPlan };
}
it.each([null, true, [], {}, { checks: {}, new_questions: [] }, { checks: [], new_questions: null }])(
  "persists one default for malformed response %j", async payload => {
    const { t, llm, traceId, root, plan, save, insertPlan } = await start(payload);
    expect(plan.created_by).toBe("default"); expect(save).not.toHaveBeenCalled();
    t.roots.ingest([batch([toolSpan(traceId, root, "lookup_order", "{}", "ok")])]);
    expect(await t.roots.engine!.waitIdle(traceId, 5000)).toBe(true);
    expect(t.roots.store.getRun(traceId)!.plan_id).toBe(plan.id);
    expect(insertPlan).toHaveBeenCalledTimes(1);
    expect(llm.requests.filter(r => r.response_format?.json_schema?.name === "plan")).toHaveLength(1);
  },
);
it("keeps valid selections and questions when the model includes an unknown ID or short ask", async () => {
  const { plan, save } = await start({
    checks: [{ id: "unknown-check" }, { id: "system-prompt-violation", params: { instruction: "Confirm ownership" } }],
    new_questions: [{ id: "short", ask: "Why?" }, question],
  });
  expect(plan.created_by).toBe("planner");
  expect(plan.check_ids).toContain("system-prompt-violation");
  expect(plan.params["system-prompt-violation"]).toEqual({ instruction: "Confirm ownership" });
  expect(plan.check_ids).toContain("test-agent.refund-policy");
  expect(plan.check_ids).not.toContain("unknown-check");
  expect(save).toHaveBeenCalledTimes(1);
});
it("filters malformed entries before any registry write without discarding their valid neighbors", async () => {
  const { plan, save } = await start({
    checks: [null, 42, { id: 7 }, { id: "system-prompt-violation", params: JSON.parse('{"__proto__":"bad"}') }, { id: "unfinished-task" }],
    new_questions: [null, true, { ...question, ask: 7 }, { ...question, guidance: {} }, question],
  });
  expect(plan.created_by).toBe("planner"); expect(plan.check_ids).toContain("unfinished-task");
  expect(plan.check_ids).toContain("test-agent.refund-policy"); expect(save).toHaveBeenCalledTimes(1);
  expect(plan.params).toEqual({});
});
it("skips unusable and colliding generated IDs while retaining distinct questions", async () => {
  const { plan, save } = await start({ checks: [], new_questions: [
    { ...question, id: "!!!" }, { ...question, id: "a b" }, { ...question, id: "a-b" },
  ] });
  expect(plan.created_by).toBe("planner"); expect(save).toHaveBeenCalledTimes(1);
  expect(plan.check_ids).toContain("test-agent.a-b");
  expect(new Set(plan.check_ids).size).toBe(plan.check_ids.length);
});
it("does not overwrite an earlier recommendation with a generated ID collision", async () => {
  const { t, plan, save } = await start({ checks: [], new_questions: [
    { ...question, id: "refund-policy" }, { ...question, id: "refund_policy", ask: "Did a different rule overwrite this question?" },
  ] });
  expect(save).toHaveBeenCalledTimes(1);
  expect(t.roots.checks.get("test-agent.refund-policy")!.check).toMatchObject({ ask: question.ask });
  expect(plan.check_ids.filter(id => id === "test-agent.refund-policy")).toHaveLength(1);
});
it("keeps absent and placeholder ID fallbacks and valid span guidance", async () => {
  const { plan, save } = await start({ checks: [], new_questions: [
    { ask: question.ask }, { id: "question-1", ask: "Did the tool reveal private customer data?", scope: "span", span_type: "tool", guidance: "Remove private data." },
  ] });
  expect(plan.created_by).toBe("planner"); expect(save).toHaveBeenCalledTimes(2);
  expect(save.mock.calls[1][0]).toMatchObject({ scope: "span", guidance: "Remove private data." });
});
