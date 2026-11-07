import assert from 'node:assert/strict';
import test from 'node:test';
import { extractJobLink } from '../src/lib/job-link';
test('preserves mobile Liepin hostname and tracking query from the supplied case', () => {
  assert.equal(extractJobLink('m.liepin.com/job/1985589403.shtml?mscid=wx_h5_001'), 'https://m.liepin.com/job/1985589403.shtml?mscid=wx_h5_001');
});
test('accepts shared links and arbitrary explicit company careers URLs', () => {
  assert.equal(extractJobLink('分享 https://careers.example.com/jobs/42 了解详情'), 'https://careers.example.com/jobs/42');
  assert.equal(extractJobLink('分享 m.liepin.com/job/123.shtml'), 'https://m.liepin.com/job/123.shtml');
  assert.equal(extractJobLink('job/abc-123'), 'https://www.zhipin.com/job_detail/abc-123.html');
});
test('rejects credential-bearing and non-URL input', () => {
  assert.equal(extractJobLink('https://user:password@example.com/job'), null);
  assert.equal(extractJobLink('javascript:alert(1)'), null);
  assert.equal(extractJobLink('普通岗位描述'), null);
});
