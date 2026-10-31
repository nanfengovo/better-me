import type { CoachRequest } from "./types";

// Decoder hints for local Ollama. Zod plus the workflow/source checks remain
// authoritative; a provider claiming schema compliance is never sufficient.
type Schema = Record<string, unknown>;
const text: Schema = { type: "string", minLength: 1, maxLength: 4000 };
const short: Schema = { type: "string", minLength: 1, maxLength: 400 };
const integer = (minimum: number, maximum: number): Schema => ({ type: "integer", minimum, maximum });
const list = (items: Schema, maxItems = 12, minItems = 0): Schema => ({ type: "array", items, minItems, maxItems });
const object = (properties: Record<string, Schema>, optional: string[] = []): Schema => ({
  type: "object", properties, required: Object.keys(properties).filter((key) => !optional.includes(key)), additionalProperties: false,
});
const kind = (value: string): Schema => ({ type: "string", const: value });
const feedback = object({
  summary: text, strengths: list(text), improvements: list(text),
  rubric: list(object({ criterion: short, score: integer(0, 4), comment: text }), 5, 1),
});

export function coachOutputSchema(request: CoachRequest): Schema {
  switch (request.mode) {
    case "analysis": return object({
      kind: kind("analysis"), summary: text,
      directions: list(object({ title: short, reason: text, evidence: list(text), tradeoffs: list(text) }), 4, 1),
      strengths: list(text), gaps: list(object({ skill: short, status: { type: "string", enum: ["unknown", "needs_practice"] }, reason: text })),
      questions: list(object({ question: text, why: text, options: list(short, 5) }), 3), nextActions: list(text),
    });
    case "plan": return object({
      kind: kind("plan"), title: short, goal: text,
      durationWeeks: { type: "integer", const: request.settings.durationWeeks },
      weeklyHours: { type: "number", const: request.settings.weeklyHours },
      phases: list(object({
        title: short, startWeek: integer(1, request.settings.durationWeeks), endWeek: integer(1, request.settings.durationWeeks), objective: text,
        tasks: list(object({
          id: { type: "string", minLength: 1, maxLength: 80 }, title: short, week: integer(1, request.settings.durationWeeks),
          minutes: integer(15, Math.min(1200, Math.floor(request.settings.weeklyHours * 60))), deliverable: text,
          acceptanceCriteria: list(text, 6, 1), resourceQueries: list(short, 5),
        }), 12, 1),
      }), Math.min(8, request.settings.durationWeeks), 1),
      risks: list(text), reviewCadence: text,
    });
    case "resume": return object({
      kind: kind("resume"), summary: text,
      proposals: list(object({
        targetRef: { anyOf: [
          object({ kind: kind("profile_headline"), locale: { type: "string", enum: ["zh", "en"] } }),
          object({ kind: kind("claim_text"), experienceId: { type: "string", minLength: 1, maxLength: 160 }, claimId: { type: "string", minLength: 1, maxLength: 160 }, locale: { type: "string", enum: ["zh", "en"] } }),
        ] },
        originalText: { type: "string", minLength: 1, maxLength: 12000 }, proposedText: { type: "string", minLength: 1, maxLength: 12000 }, rationale: text,
      })),
    });
    case "review": return object({
      kind: kind("review"), summary: text,
      evidenceAssessment: { type: "string", enum: ["insufficient", "needs_revision", "ready_for_self_check"] },
      strengths: list(text), improvements: list(text), nextActions: list(text), checkQuestions: list(text),
    });
    case "interview": {
      const answered = request.interview?.turns.length ?? 0;
      const complete = answered >= (request.interview?.totalRounds ?? request.settings.interviewRounds);
      return object({
        kind: kind("interview"), complete: { type: "boolean", const: complete },
        ...(!complete ? { question: object({ text, focus: short, evaluationCriteria: list(text, 5, 1) }) } : { summary: text }),
        ...(answered ? { feedback } : {}), nextActions: list(text),
      });
    }
  }
}
