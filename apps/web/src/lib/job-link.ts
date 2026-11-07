export function extractJobLink(text: string): string | null {
  const value = text.trim();
  const short = value.match(/^\/?(?:job|job_detail)\/([a-z\d_-]+)/i);
  if (short) return `https://www.zhipin.com/job_detail/${short[1]}.html`;
  const explicit = value.match(/https?:\/\/[^\s<>"「」『』。，；！？【】《》]+/i)?.[0];
  const bare = value.match(/(?:^|\s)((?:[a-z0-9-]+\.)*(?:liepin\.com|zhipin\.com|51job\.com)\/[^\s<>"「」『』。，；！？【】《》]*)/i)?.[1];
  const candidate = explicit || (bare ? `https://${bare}` : undefined);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const boss = /^(?:www\.)?zhipin\.com$/i.test(url.hostname) && url.pathname.match(/^\/(?:job|job_detail)\/([a-z\d_-]+)/i);
    if (boss) return `https://www.zhipin.com/job_detail/${boss[1]}.html`;
    return url.href;
  } catch { return null; }
}
