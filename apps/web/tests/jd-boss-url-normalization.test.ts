import assert from "node:assert/strict";
import test from "node:test";

test("BOSS 直聘移动端短链自动转桌面端详情页规范化", () => {
  const mobileUrls = [
    "https://m.zhipin.com/mpa/html/weijd/weijd-job/fb798685269e3fb10nN40tS8GFdZ?date8=20261022&sid=tosee_jd_2f369260e93318930nJy3t69EltV&openWeapp=1&fromSource=2",
    "http://m.zhipin.com/mpa/html/weijd/weijd-job/02d03c8563d57f3b0nN-09i7E1BZ",
    "m.zhipin.com/mpa/html/weijd/weijd-job/test_token_123/?fromSource=1",
    "https://www.zhipin.com/job_detail/fb798685269e3fb10nN40tS8GFdZ.html",
  ];

  function normalizeBossInput(input: string): string {
    let normalizedInput = input.trim();
    const bossMobileMatch = normalizedInput.match(/(?:https?:\/\/)?(?:m|www)\.zhipin\.com\/mpa\/html\/weijd\/weijd-job\/([a-z\d_-]+)/i);
    if (bossMobileMatch) {
      return `https://www.zhipin.com/job_detail/${bossMobileMatch[1]}.html`;
    }
    const bossShortMatch = normalizedInput.match(/^(?:https?:\/\/(?:www\.)?zhipin\.com\/)?(?:job|job_detail)\/([a-z\d_-]+)/i);
    if (bossShortMatch) {
      return `https://www.zhipin.com/job_detail/${bossShortMatch[1]}.html`;
    }
    return input;
  }

  assert.equal(
    normalizeBossInput(mobileUrls[0]),
    "https://www.zhipin.com/job_detail/fb798685269e3fb10nN40tS8GFdZ.html"
  );
  assert.equal(
    normalizeBossInput(mobileUrls[1]),
    "https://www.zhipin.com/job_detail/02d03c8563d57f3b0nN-09i7E1BZ.html"
  );
  assert.equal(
    normalizeBossInput(mobileUrls[2]),
    "https://www.zhipin.com/job_detail/test_token_123.html"
  );
  assert.equal(
    normalizeBossInput(mobileUrls[3]),
    "https://www.zhipin.com/job_detail/fb798685269e3fb10nN40tS8GFdZ.html"
  );
});
