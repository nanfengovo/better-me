import assert from "node:assert/strict";
import test from "node:test";
import type { SourceJobRecord, SourceScope } from "../src/contracts.js";
import { assessSourceScopeMatch, countSourceScopeMatches, locallyMatchesSourceScope } from "../src/local-match.js";

const scope = (roles: string[], extra: Partial<SourceScope> = {}): SourceScope => ({ roles, regions: [], companyNames: [], ...extra });
function job(extra: Partial<SourceJobRecord> = {}): SourceJobRecord {
  return { entityType: 'job-posting', sourceRecordId: 'synthetic', url: 'https://careers.example.test/job/synthetic',
    title: '后端工程师', companyName: 'Synthetic Employer', description: '开发高可用服务，要求熟练 C# 与 SQL',
    locations: [{ raw: '中国 · 上海', countryCode: 'CN', city: '上海' }], compensations: [], workMode: 'unknown', employmentType: 'unknown',
    remoteEligibleRegions: [], availability: 'unknown', completeness: 'detail', evidence: [], warnings: [], ...extra };
}

test('role terms use AND across fields, OR between interests, ordinary fuzzy words and protected exact C#/C++/.NET tokens', () => {
  assert.equal(locallyMatchesSourceScope(job(), scope(['C# 后端'])), true, 'title and requirement need not be contiguous or in query order');
  assert.equal(locallyMatchesSourceScope(job(), scope(['Python', 'C# 后端'])), true, 'separate interests retain OR');
  assert.equal(locallyMatchesSourceScope(job({ title: 'Backend engineer', description: 'Build production C# services' }), scope(['C# engnieer'])), true);
  for (const description of ['Build C services', 'Build C++ services', 'Sharp designer', 'CSharpener operator', 'Cppcheck maintainer', 'Operate example.net']) {
    assert.equal(locallyMatchesSourceScope(job({ title: '后端工程师', description }), scope(['C# 后端'])), false, description);
  }
  assert.equal(locallyMatchesSourceScope(job({ title: 'ASP.NET8 engineer', description: 'Build services' }), scope(['.NET engnieer'])), true);
  assert.equal(locallyMatchesSourceScope(job({ title: 'C++17 engineer', description: 'Build services' }), scope(['C++ engnieer'])), true);
});

test('an unread requirement remains unknown while fully read nonmatching content and explicit other offices are excluded', () => {
  const excerpt = job({ title: '服务端工程师', description: '开发服务', completeness: 'excerpt' });
  assert.deepEqual(assessSourceScopeMatch(excerpt, scope(['C#'])), { status: 'unknown', roleMatch: false, nonRoleMatch: true });
  assert.equal(locallyMatchesSourceScope(excerpt, scope(['C#'])), false, 'unknown must not become a positive match');
  assert.equal(assessSourceScopeMatch({ ...excerpt, completeness: 'detail' }, scope(['C#'])).status, 'excluded');
  assert.equal(assessSourceScopeMatch(excerpt, scope(['C#'], { regions: ['深圳'] })).status, 'excluded');
  assert.deepEqual(countSourceScopeMatches([job(), excerpt, { ...excerpt, completeness: 'detail' }], scope(['C#'])), { matched: 1, unknown: 1, excluded: 1 });
});

test('company and same-office country/region constraints stay literal and do not borrow another office or remote eligibility', () => {
  const offices = job({ locations: [{ raw: 'US Seattle', countryCode: 'US', city: 'Seattle' }, { raw: 'AU Springfield', countryCode: 'AU', city: 'Springfield' }], remoteEligibleRegions: ['Springfield'] });
  assert.equal(locallyMatchesSourceScope(offices, scope(['C#'], { countryCodes: ['US'], regions: ['Springfield'] })), false);
  assert.equal(locallyMatchesSourceScope(offices, scope(['C#'], { countryCodes: ['US'], regions: ['Seattle'] })), true);
  assert.equal(locallyMatchesSourceScope(offices, scope(['C#'], { regions: ['US'] })), true);
  assert.equal(locallyMatchesSourceScope(job({ companyName: 'Another employer' }), scope(['C#'], { companyNames: ['Synthetic Employer'] })), false);
  assert.equal(locallyMatchesSourceScope(job(), scope(['C#'], { companyNames: ['Synthetiq Employer'] })), false, 'employer constraints do not gain typo matching');
});

test('main text can match disclosed city terms across the same fields offered by the indexed UI', () => {
  assert.equal(locallyMatchesSourceScope(job(), scope(['C# 上海'])), true);
  assert.equal(locallyMatchesSourceScope(job(), scope(['C# 北京'])), false);
  assert.equal(locallyMatchesSourceScope(job(), scope([])), true);
  assert.equal(locallyMatchesSourceScope(job(), scope(['!!!'])), false);
});
