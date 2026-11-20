import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { gradeProjectEvidence } from "./project-evidence-live.mjs";

test("live project score requires exact file bytes, active references, the two requested facts and an eligible result", async () => {
  const gold = JSON.parse(await readFile(new URL("./gold/warehouse-replay-v1.json", import.meta.url), "utf8"));
  const evidence = gold.sources.map((s: {id:string; text:string}) => {
    const header = "历史项目记录\n", full = header + s.text;
    return {id:s.id, grantId:"granted", path:s.id+".md", hash:createHash("sha256").update(full).digest("hex"),
      startOffset:header.length, endOffset:full.length, startLine:2, endLine:full.split("\n").length, excerpt:s.text};
  });
  const claims = gold.expectedFacts.map((f:{sourceId:string; quote:string}) => ({
    kind:"documentation",text:f.quote,evidenceIds:[f.sourceId],
  }));
  claims.push({kind:"inference",text:"按编号去重可能减少重复入库处理。",evidenceIds:["warehouse-dedup"]},
    {kind:"unknown",text:"上线收益未知。",evidenceIds:[]});
  const task = {status:"awaiting_review",project:{grants:[{id:"granted"}],evidence,understanding:{claims}}};
  assert.equal(gradeProjectEvidence(gold,task).passed,true);
  const invalid = [
    (t:typeof task) => { t.project.evidence[0].startOffset++; },
    (t:typeof task) => { t.project.evidence[0].startLine++; },
    (t:typeof task) => { t.project.evidence[0].hash = "replaced"; },
    (t:typeof task) => { t.project.grants = []; },
    (t:typeof task) => { t.project.understanding.claims[0].evidenceIds = ["warehouse-layout"]; },
    (t:typeof task) => { t.project.understanding.claims[1].text = gold.expectedFacts[1].quote.slice(1); },
    (t:typeof task) => { t.project.understanding.claims[1].text += "并将生产错误率降低了 40%。"; },
    (t:typeof task) => { t.project.understanding.claims[2].text = "去重将增加重复处理。"; },
    (t:typeof task) => { t.project.understanding.claims[2].text = "去重可能减少重复处理属于哪一类结论？"; },
    (t:typeof task) => { t.project.understanding.claims[3].text = "上线收益已经证实。"; },
    (t:typeof task) => { t.project.understanding.claims.push({kind:"documentation",text:"货架图",evidenceIds:["warehouse-layout"]}); },
    (t:typeof task) => { t.status = "paused"; },
  ];
  for (const alter of invalid) {
    const wrong = structuredClone(task);
    alter(wrong);
    assert.equal(gradeProjectEvidence(gold,wrong).passed,false);
  }
});
