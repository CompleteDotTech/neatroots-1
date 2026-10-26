import { z } from "zod";

// Validate the response envelope before processing individual recommendations.
const Envelope = z.object({
  rationale: z.string().optional(), checks: z.array(z.unknown()), new_questions: z.array(z.unknown()),
});
const Parameters = z.unknown().refine(
  value => value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every(key => !["__proto__", "prototype", "constructor"].includes(key)),
).pipe(z.record(z.string(), z.string()));
const Selection = z.object({ id: z.string().min(1), params: Parameters.optional() });
const Question = z.object({
  id: z.string().optional(), ask: z.string().trim().min(12),
  scope: z.enum(["span", "trace"]).optional(), span_type: z.enum(["llm", "tool", "any"]).optional(),
  guidance: z.string().optional(),
});
export interface PlannerOutput {
  rationale?: string;
  checks: z.infer<typeof Selection>[];
  new_questions: z.infer<typeof Question>[];
}

/** Keep usable entries; only an invalid response envelope rejects the whole plan. */
export function parsePlannerOutput(value: unknown): PlannerOutput {
  const envelope = Envelope.parse(value);
  return {
    rationale: envelope.rationale,
    checks: envelope.checks.flatMap(value => {
      const parsed = Selection.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    }),
    new_questions: envelope.new_questions.flatMap(value => {
      const parsed = Question.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    }),
  };
}

/** Return no ID for a recommendation that cannot name a usable check. */
export function generatedPlannerId(workflow: string, question: PlannerOutput["new_questions"][number]): string | undefined {
  const base = question.id && !/^(new|question|q|check)[-_ ]?\d*$|new[-_]?question/i.test(question.id) ? question.id : question.ask;
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const name = normalize(base);
  return name ? `${normalize(workflow) || "check"}.${name}`.slice(0, 64) : undefined;
}
