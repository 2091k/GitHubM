import { supabase } from '@/db/supabase';

/**
 * 翻译语言枚举
 */
export type TranslateLang = 'auto' | 'zh' | 'en' | 'jp' | 'kor' | 'fra' | 'de' | 'spa' | 'ru';

/**
 * 翻译文本（调用 Edge Function）
 * @param q 待翻译文本（不能超过 6000 字符）
 * @param from 源语言代码（默认 auto）
 * @param to 目标语言代码
 * @returns 翻译结果对象
 */
export async function translateText(
  q: string,
  from: TranslateLang = 'auto',
  to: TranslateLang
): Promise<{ from: string; to: string; trans_result: Array<{ src: string; dst: string }> }> {
  if (!q.trim()) {
    return { from, to, trans_result: [] };
  }

  const { data, error } = await supabase.functions.invoke('text-translation', {
    body: { q, from, to }
  });

  if (error) {
    console.error('Translation Edge Function Error:', error);
    throw error;
  }

  if (data?.error_code) {
    console.error('Translation API Error:', data.error_code, data.error_msg);
    throw new Error(`翻译失败 (${data.error_code}): ${data.error_msg}`);
  }

  return data.result;
}
