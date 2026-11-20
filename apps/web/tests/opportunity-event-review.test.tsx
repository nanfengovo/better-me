import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { addOpportunity, captureOpportunityDecision, consentedOpportunityEvaluations, emptyOpportunityLibrary, recordOpportunityDecisionAction, recordOpportunityEvaluation, recordOpportunityMaterial, reviewOpportunityEvent, type OpportunityLibrary } from "../src/lib/opportunities.ts";

const AT = "2026-11-20T02:00:00Z";
const evidence = { total: 1, supported: 1, partial: 0, independentRetests: [] };
const officialVersion = { documentId: "synthetic-document", versionId: "adopted-version", contentHash: "a".repeat(64) };

test("the real action review panel requires actual-action confirmation and separate sample consent", async () => {
  const dom = new Window({ url: "https://opportunity-review-fixture.invalid" });
  const React = await import("react");
  const { createElement: h, act, useState } = React;
  const globals = { window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { UiPreferencesProvider } = await import("../src/lib/ui-preferences.tsx");
  const { OpportunityEventReviewPanel } = await import("../src/components/OpportunityEventReview.tsx");
  const { createRoot } = await import("react-dom/client");
  dom.document.body.innerHTML = "<main></main>";
  const root = createRoot(dom.document.querySelector("main")! as unknown as Element);
  const initial = addOpportunity(emptyOpportunityLibrary(), { company: "Synthetic", title: "Engineer", description: "Design", status: "open" }, AT);
  let current = initial.library;
  const stages = { saved: "Saved", evaluating: "Evaluating", preparing: "Preparing", applied: "Applied", interview: "Interview", offer: "Offer", rejected: "Rejected", withdrawn: "Withdrawn" };
  function Fixture() {
    const [library, setLibrary] = useState(initial.library);
    function save(next: OpportunityLibrary) { current = next; setLibrary(next); return true; }
    return h(OpportunityEventReviewPanel, { job: library.jobs[0]!, stages, disabled: false, onDirtyChange: () => {},
      onRecommend: async () => save(captureOpportunityDecision(library, initial.job.id, evidence, officialVersion, AT)),
      onCaptureMaterial: async () => {
        const next = recordOpportunityMaterial(library, initial.job.id, { resumeViewId: "view", resumeName: "Synthetic resume", resumeUpdatedAt: AT, markdown: "# Synthetic", locale: "en", officialVersion }, AT);
        save(next); return next.jobs[0]!.materials.at(-1)!.id;
      },
      onRecordAction: (decisionId, review) => save(recordOpportunityDecisionAction(library, initial.job.id, decisionId, review, { occurredConfirmed: true, now: AT })),
      onSave: (kind, eventId, review) => save(reviewOpportunityEvent(library, initial.job.id, kind, eventId, review, AT)),
      onEvaluate: (actionId, consent) => save(recordOpportunityEvaluation(library, initial.job.id, actionId, consent, AT)),
    });
  }
  function button(name: string) {
    const node = [...dom.document.querySelectorAll("button")].find(item => item.textContent === name);
    assert.ok(node, `Missing button ${name}`); return node;
  }
  function label(name: string) {
    const node = [...dom.document.querySelectorAll("label")].find(item => item.firstChild?.textContent === name);
    assert.ok(node, `Missing field ${name}`); return node;
  }
  async function click(name: string) { await act(async () => button(name).click()); }
  try {
    await act(async () => root.render(h(UiPreferencesProvider, { initialPreferences: { locale: "en", theme: "light" }, children: h(Fixture) })));
    await click("Recommend an action");
    assert.equal(current.jobs[0]!.decisions![0]!.action, "apply");
    assert.equal(current.jobs[0]!.application.actions, undefined);
    await click("Record the action actually taken");
    assert.equal(button("Save review").disabled, true);
    await click("Record current resume as the material used");
    const material = current.jobs[0]!.materials[0]!;
    assert.equal(label("Resume snapshot actually used").querySelector("select")!.value, material.id);
    const reason = label("Why you took this action").querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(reason, "Proceed following review");
      reason.dispatchEvent(new dom.Event("input", { bubbles: true }));
    });
    const submit = dom.document.querySelector("form")!;
    const confirm = dom.document.querySelector(".application-communication-confirm input")!;
    await act(async () => confirm.click());
    assert.equal(button("Save review").disabled, false);
    await act(async () => submit.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true })));
    const action = current.jobs[0]!.application.actions![0]!;
    assert.deepEqual(action.review.officialVersion, officialVersion);
    assert.equal(action.review.feedback, "unobserved");
    assert.equal(consentedOpportunityEvaluations(current).length, 0);
    assert.equal(button("Record anonymous sample").disabled, true);
    await act(async () => dom.document.querySelector(".opportunity-decision-confirm input")!.click());
    await click("Record anonymous sample");
    assert.equal(consentedOpportunityEvaluations(current)[0]!.outcome, "unknown");
    await click("Withdraw sample consent");
    assert.equal(consentedOpportunityEvaluations(current).length, 0);
  } finally {
    await act(async () => root.unmount());
    dom.happyDOM.abort();
    for (const [key, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});
