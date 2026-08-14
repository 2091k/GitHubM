/**
 * 翻译 API（纯前端直连，脱离 Supabase 后端）
 *
 * 直连 MyMemory 免费翻译服务：
 * - 无需 API Key、无需后端代理，浏览器可直接调用（CORS 开放）
 * - 匿名配额：约 5000 字符/天/IP；足够个人日常浏览翻译使用
 * - 单次请求上限 500 字节：按行拆分、限并发 3、单批最多 30 行
 *
 * 不再依赖 text-translation Edge Function（保留在仓库中备选，前端已不调用）。
 */

/**
 * 翻译语言枚举
 */
export type TranslateLang = 'auto' | 'zh' | 'en' | 'jp' | 'kor' | 'fra' | 'de' | 'spa' | 'ru';

/** 语言代码映射：前端代码 → MyMemory 代码 */
const LANG_MAP: Record<string, string> = {
  zh: 'zh-CN',
  en: 'en-GB',
  jp: 'ja',
  kor: 'ko',
  fra: 'fr',
  de: 'de',
  spa: 'es',
  ru: 'ru',
};

/** 单批最大行数（防止批量翻译时请求爆炸） */
const MAX_LINES_PER_BATCH = 30;
/** 并发请求数 */
const CONCURRENCY = 3;

/** 检测文本主语言（auto 时确定源语言）：含中日韩字符视为中文源 */
function detectSource(text: string): string {
  return /[\u4e00-\u9fa5\u0800-\u4e00]/.test(text) ? 'zh-CN' : 'en';
}

/** 单条文本翻译（MyMemory 直连），失败返回 null */
async function callMyMemory(q: string, src: string, dst: string): Promise<string | null> {
  try {
    const url =
      `https://api.mymemory.translated.net/get` +
      `?q=${encodeURIComponent(q)}&langpair=${encodeURIComponent(`${src}|${dst}`)}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    const translated: string | undefined = data?.responseData?.translatedText;
    return translated && translated.trim() ? translated : null;
  } catch {
    return null;
  }
}

/**
 * 翻译文本（直连 MyMemory）
 * @param q 待翻译文本（可含换行，将按行拆分请求）
 * @param from 源语言代码（默认 auto 自动检测）
 * @param to 目标语言代码
 * @returns 翻译结果对象（与原 Edge Function 返回格式保持一致）
 */
export async function translateText(
  q: string,
  from: TranslateLang = 'auto',
  to: TranslateLang
): Promise<{ from: string; to: string; trans_result: Array<{ src: string; dst: string }> }> {
  if (!q.trim()) {
    return { from, to, trans_result: [] };
  }

  const target = LANG_MAP[to] ?? to;

  // 按行拆分（MyMemory 单次 500 字节限制），最多处理前 30 行
  const lines = q
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, MAX_LINES_PER_BATCH);

  if (lines.length === 0) {
    return { from, to, trans_result: [] };
  }

  const trans_result: Array<{ src: string; dst: string }> = [];
  let cursor = 0;

  // 限并发 3 的工人池
  const workers = Array.from({ length: Math.min(CONCURRENCY, lines.length) }, async () => {
    while (cursor < lines.length) {
      const line = lines[cursor++];
      const src = from === 'auto' ? detectSource(line) : LANG_MAP[from] ?? from;
      const dst = await callMyMemory(line, src, target);
      if (dst) {
        trans_result.push({ src: line, dst });
      }
    }
  });

  await Promise.all(workers);

  if (trans_result.length === 0) {
    throw new Error('翻译服务暂不可用（MyMemory 直连失败），请稍后再试');
  }

  return { from: from === 'auto' ? 'auto' : from, to, trans_result };
}