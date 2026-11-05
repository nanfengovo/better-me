/** External generator substitute for deterministic regression ONLY. */
export const fixtureSource = `function(input) {
 if(!input||!input.before||!input.after)throw Error('invalid');
 return ['before','after'].flatMap(batch=>{const b=input[batch];
 if(!['board-v1','board-v2'].includes(b.format))throw Error('format');
 const a=b.format==='board-v1'?b.jobs:b.positions;if(!Array.isArray(a))throw Error('rows');
 return a.map((j,index)=>({batch,index,sourceNamespace:b.sourceNamespace,jobId:b.format==='board-v1'?j.jobId:j.id,
 title:b.format==='board-v1'?j.title:j.name,requirements:b.format==='board-v1'?j.requirements:j.needs,snapshotAt:b.capturedAt}));});}`;
