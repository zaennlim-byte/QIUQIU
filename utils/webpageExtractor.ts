// 网页分享 — 把用户粘贴的网址抓成「角色能看见」的纯文字。
//
// 设计目标（对齐 html_card / xhs_card 的「卡片给人看、纯文字摘要喂 LLM」模式）：
//  1) 用户在聊天里粘贴一个 http(s) 链接 → 抓取网页 → 存成 webpage_card 消息；
//  2) 卡片在聊天里渲染成标题 + 摘要的小卡（components/chat/MessageItem.tsx）；
//  3) 上下文 / 归档只看到剥离 HTML 后的纯文字正文（utils/messageFormat.ts），角色就「读到」了网页内容。
//
// CORS：浏览器直接 fetch 别人家网页绝大多数会被跨域挡掉。主路径走项目的 sfworker 代理
// （worker/index.js 的 /fetch-webpage 端点，跟小红书签名 / weapi / Brave 搜索同一个 worker）；
// 代理不可用时兜底尝试前端直连（多数会失败，失败就抛错让调用方提示用户）。

import { htmlToText } from './htmlPrompt';

// sfworker：项目自带的通用代理 Worker（小红书签名 / 网易云 weapi / Brave 搜索 / WebDAV /
// 网页抓取都走它，代码见 worker/index.js）。二改请换成你自己的 Worker 地址 ——
// 见 README「后端有几处接了我的 sfworker」。
const SFWORKER_URL = 'https://sullymeow.ccwu.cc';

/** 抓取并解析后的网页结构。卡片 metadata 存这一份。 */
export interface ExtractedWebpage {
  /** 抓取用的原始 URL（跳转后可能与 finalUrl 不同）。 */
  url: string;
  /** 重定向后的最终 URL（worker 能拿到时回填，否则等于 url）。 */
  finalUrl?: string;
  /** 网页标题（<title> / og:title）。 */
  title: string;
  /** 站点名（og:site_name / 域名兜底）。 */
  siteName?: string;
  /** 提取出的正文纯文字（已截断到 MAX_CONTENT_CHARS）。 */
  content: string;
  /** 短摘要（meta description / 正文开头）。 */
  excerpt: string;
  /** 正文是否因超长被截断。 */
  truncated: boolean;
  /** 抓取时间戳。 */
  fetchedAt: number;
}

/** 卡片 metadata 里正文的存储上限：太长既占 IndexedDB 也没必要全留。 */
const MAX_CONTENT_CHARS = 8000;
/** 摘要长度。 */
const EXCERPT_CHARS = 140;

/**
 * 从一段文本里揪出第一个 http(s) 链接。返回 null 表示没有可抓的链接。
 * 末尾的常见标点（。，！？、）以及成对括号不算进 URL，避免把中文句号粘进去。
 */
export function detectFirstUrl(text: string): string | null {
  if (!text) return null;
  const m = text.match(/https?:\/\/[^\s，。！？；、"'《》()（）【】]+/i);
  if (!m) return null;
  // 去掉尾部可能误吞的英文标点
  return m[0].replace(/[.,;:!?'")\]]+$/, '');
}

/** XHS 链接已有专门的 MCP 卡片路径，网页抓取要避开它，免得抢同一条消息。 */
export function isXhsUrl(url: string): boolean {
  return /xiaohongshu\.com|xhslink\.com/i.test(url);
}

/**
 * 通过 sfworker 的 /fetch-webpage 代理抓取网页 HTML（绕过浏览器 CORS）。
 * 失败抛错（由 extractWebpageContent 兜底到直连）。
 */
async function fetchHtmlViaWorker(url: string): Promise<{ html: string; finalUrl?: string }> {
  const res = await fetch(`${SFWORKER_URL}/fetch-webpage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const text = await res.text().catch(() => '');
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* non-json */ }

  if (!res.ok || !parsed?.success) {
    // sfworker 失败返回 { error: '中文说明' }（字符串）；也兼容 { error: { message } }。
    const err = parsed?.error;
    const msg = (err && (err.message || err)) || `网页抓取失败 (HTTP ${res.status})`;
    throw new Error(typeof msg === 'string' ? msg : '网页抓取失败');
  }
  const html = String(parsed?.data?.html || '');
  if (!html) throw new Error('worker 返回的网页内容为空');
  return { html, finalUrl: parsed?.data?.finalUrl };
}

/** 直连兜底：大多数站点会被 CORS 挡掉，仅对放开跨域的页面有效。 */
async function fetchHtmlDirect(url: string): Promise<{ html: string }> {
  const res = await fetch(url, { headers: { Accept: 'text/html,application/xhtml+xml' } });
  if (!res.ok) throw new Error(`直连抓取失败 (HTTP ${res.status})`);
  const html = await res.text();
  if (!html) throw new Error('网页内容为空');
  return { html };
}

/**
 * 把 HTML 解析成「正文纯文字 + 标题 + 摘要」。纯前端用 DOMParser，不引第三方库。
 * 启发式：去掉 script/style/nav/header/footer/aside 等噪音节点，优先取 <article>/<main>，
 * 退而取 <body>，再用现成的 htmlToText() 转纯文字。
 */
export function parseWebpageHtml(html: string, url: string): {
  title: string;
  siteName?: string;
  content: string;
  excerpt: string;
} {
  let title = '';
  let siteName: string | undefined;
  let metaDesc = '';
  let content = '';

  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // 标题：og:title 优先，其次 <title>。
    const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute('content');
    title = (ogTitle || doc.querySelector('title')?.textContent || '').trim();

    siteName = doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content')?.trim() || undefined;
    metaDesc = (
      doc.querySelector('meta[name="description"]')?.getAttribute('content') ||
      doc.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
      ''
    ).trim();

    // 干掉明显的非正文噪音节点。
    doc.querySelectorAll(
      'script, style, noscript, nav, header, footer, aside, form, svg, iframe, button, [aria-hidden="true"]'
    ).forEach((el) => el.remove());

    const main = doc.querySelector('article') || doc.querySelector('main') || doc.body;
    content = htmlToText(main?.innerHTML || '');
  } catch {
    // DOMParser 不可用（极端环境）时退回纯正则剥标签。
    content = htmlToText(html);
  }

  if (!siteName) {
    try { siteName = new URL(url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
  }

  let truncatedContent = content;
  if (truncatedContent.length > MAX_CONTENT_CHARS) {
    truncatedContent = truncatedContent.slice(0, MAX_CONTENT_CHARS);
  }

  const excerptSource = metaDesc || truncatedContent;
  const excerpt = excerptSource.length > EXCERPT_CHARS
    ? excerptSource.slice(0, EXCERPT_CHARS).trim() + '…'
    : excerptSource.trim();

  return {
    title: title || siteName || '网页',
    siteName,
    content: truncatedContent,
    excerpt,
  };
}

/**
 * 抓取 + 解析一个网页，返回可直接塞进 webpage_card metadata 的结构。
 * 抓取失败（CORS / worker 报错 / 网络）时抛错，调用方负责给用户 toast。
 */
export async function extractWebpageContent(url: string): Promise<ExtractedWebpage> {
  let html = '';
  let finalUrl: string | undefined;

  const viaWorker = await fetchHtmlViaWorker(url).catch((e) => {
    // sfworker 抓取报错：记录后让直连兜底再试一把。
    console.warn('[webpageExtractor] sfworker fetch failed, will try direct:', e);
    return null;
  });

  if (viaWorker) {
    html = viaWorker.html;
    finalUrl = viaWorker.finalUrl;
  } else {
    const direct = await fetchHtmlDirect(url); // 失败直接抛给调用方
    html = direct.html;
  }

  const parsed = parseWebpageHtml(html, finalUrl || url);
  const rawContent = htmlToText(html); // 仅用于判断是否截断
  return {
    url,
    finalUrl,
    title: parsed.title,
    siteName: parsed.siteName,
    content: parsed.content,
    excerpt: parsed.excerpt,
    truncated: rawContent.length > MAX_CONTENT_CHARS,
    fetchedAt: Date.now(),
  };
}
