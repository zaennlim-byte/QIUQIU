import { describe, it, expect } from 'vitest';
import { detectFirstUrl, isXhsUrl, parseWebpageHtml } from './webpageExtractor';

describe('detectFirstUrl', () => {
  it('从一句话里揪出 http(s) 链接', () => {
    expect(detectFirstUrl('看看这个 https://example.com/article 挺有意思'))
      .toBe('https://example.com/article');
    expect(detectFirstUrl('http://foo.bar/baz')).toBe('http://foo.bar/baz');
  });

  it('中文句号不进 URL，英文尾标点被剥掉', () => {
    // 中文句号不在 URL 字符集里, 正则到此截断
    expect(detectFirstUrl('链接是 https://example.com/x。后面还有字')).toBe('https://example.com/x');
    // 英文句点/右括号结尾要被剥掉
    expect(detectFirstUrl('see (https://example.com/a).')).toBe('https://example.com/a');
  });

  it('没有链接时返回 null', () => {
    expect(detectFirstUrl('就是普通聊天没有网址')).toBeNull();
    expect(detectFirstUrl('')).toBeNull();
    expect(detectFirstUrl('ftp://nope.com')).toBeNull();
  });
});

describe('isXhsUrl', () => {
  it('识别小红书域名（已有专门 MCP 路径，网页抓取要避开）', () => {
    expect(isXhsUrl('https://www.xiaohongshu.com/explore/abc')).toBe(true);
    expect(isXhsUrl('https://xhslink.com/xxx')).toBe(true);
    expect(isXhsUrl('https://example.com')).toBe(false);
  });
});

describe('parseWebpageHtml', () => {
  // node 测试环境无 DOMParser，会走正则 fallback（htmlToText）。两条路径都应产出标题/正文。
  const html = `
    <html><head>
      <title>测试标题</title>
      <meta name="description" content="这是一段网页摘要描述">
      <meta property="og:site_name" content="测试站">
    </head><body>
      <nav>导航不该进正文</nav>
      <article><p>第一段正文内容。</p><p>第二段正文内容。</p></article>
      <script>console.log('noise')</script>
    </body></html>`;

  it('提取出正文文字（去掉 script 噪音）', () => {
    const r = parseWebpageHtml(html, 'https://test.example.com/p');
    expect(r.content).toContain('第一段正文内容');
    expect(r.content).toContain('第二段正文内容');
    expect(r.content).not.toContain('console.log');
  });

  it('没有站点名时用域名兜底', () => {
    const r = parseWebpageHtml('<p>hi</p>', 'https://www.foo.bar/x');
    expect(r.siteName).toBe('foo.bar');
    expect(r.title).toBeTruthy();
  });

  it('摘要非空且有上限', () => {
    const longBody = '<p>' + '内容'.repeat(500) + '</p>';
    const r = parseWebpageHtml(longBody, 'https://x.com');
    expect(r.excerpt.length).toBeLessThanOrEqual(141); // 140 + 省略号
  });
});
