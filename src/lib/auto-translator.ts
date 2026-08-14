import { translateText, TranslateLang } from './api/translation';

function shouldTranslate(text: string, targetLang: TranslateLang): boolean {
  if (!text || text.length < 2) return false;
  // 跳过纯数字/符号
  if (!/[a-zA-Z\u4e00-\u9fa5\u0800-\u4e00]/.test(text)) return false;

  if (targetLang === 'zh') {
    // 翻译为中文：如果已经包含中文字符，则跳过
    if (/[\u4e00-\u9fa5]/.test(text)) return false;
    return true;
  }

  if (targetLang === 'en') {
    // 翻译为英文：如果包含中日韩字符，说明需要翻译为英文
    if (/[\u4e00-\u9fa5\u0800-\u4e00]/.test(text)) return true;
    return false;
  }

  return false;
}

/** 连续失败后允许的最大重试轮数（超过后放弃本批，等待新内容触发） */
const MAX_FAIL_ROUNDS = 4;
/** 单批最大节点数 */
const MAX_BATCH = 50;
/** 初始退避延迟（ms），指数增长：500 → 1000 → 2000 → 4000 → 8000 */
const BASE_BACKOFF_MS = 500;
/** 最大退避延迟（ms） */
const MAX_BACKOFF_MS = 8000;

class ViewportTranslator {
  private targetLang: TranslateLang | 'off' = 'off';
  private observer: IntersectionObserver | null = null;
  private mutationObserver: MutationObserver | null = null;

  private pendingNodes: Set<Text> = new Set();
  private translating: boolean = false;
  /** 原文保存（WeakMap 防泄漏；还原时依赖 translatedNodes 强引用集合） */
  private originalTextMap: WeakMap<Text, string> = new WeakMap();
  /** 已翻译节点强引用集合：用于关闭翻译时还原 + 防循环 */
  private translatedNodes: Set<Text> = new Set();
  private timer: number | null = null;

  /**
   * 翻译结果缓存（原文 → 译文）。
   * React 重渲染会重建文本节点，命中缓存即可秒级还原，避免重复调用上游 API，
   * 显著降低配额消耗与限流概率（翻译"失效"的主要诱因之一）。
   */
  private translationCache: Map<string, string> = new Map();

  /** 连续失败轮数（指数退避用；成功一次即归零） */
  private failRounds = 0;

  constructor() {
    this.observer = new IntersectionObserver(this.handleIntersection.bind(this), {
      rootMargin: '100px', // 提前 100px 触发
    });

    this.mutationObserver = new MutationObserver(this.handleMutations.bind(this));
  }

  public setConfig(targetLang: TranslateLang | 'off') {
    if (this.targetLang === targetLang) return;
    this.targetLang = targetLang;

    if (targetLang === 'off') {
      this.stop();
      this.restoreAll();
    } else {
      this.failRounds = 0;
      this.start();
    }
  }

  private start() {
    if (!this.observer || !this.mutationObserver) return;
    // 观察整个文档的变化
    this.mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    // 初始扫描
    this.scanAndObserve(document.body);
  }

  private stop() {
    this.observer?.disconnect();
    this.mutationObserver?.disconnect();
    this.pendingNodes.clear();
    if (this.timer) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 关闭翻译时把已翻译节点的文本还原为原文（修复：此前关闭后无法还原） */
  private restoreAll() {
    this.translatedNodes.forEach((node) => {
      const original = this.originalTextMap.get(node);
      if (original !== undefined) {
        node.nodeValue = original;
      }
    });
    this.translatedNodes.clear();
    this.pendingNodes.clear();
  }

  /** 定期清理已脱离 DOM 的节点，防止 translatedNodes 无限增长 */
  private pruneDetachedNodes() {
    if (this.translatedNodes.size < 200) return;
    let pruned = 0;
    this.translatedNodes.forEach((node) => {
      if (!node.isConnected) {
        this.translatedNodes.delete(node);
        pruned++;
      }
    });
    if (pruned > 0) {
      console.debug('[Translator] pruned', pruned, 'detached nodes');
    }
  }

  private scanAndObserve(root: Node) {
    if (this.targetLang === 'off') return;

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          // 排除 script, style, code, pre 等标签内的文本
          const parent = node.parentElement;
          if (parent && ['SCRIPT', 'STYLE', 'CODE', 'PRE', 'NOSCRIPT'].includes(parent.tagName)) {
            return NodeFilter.FILTER_REJECT;
          }
          if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let node;
    while ((node = walker.nextNode())) {
      const textNode = node as Text;
      if (this.translatedNodes.has(textNode)) continue;

      const text = textNode.nodeValue || '';
      if (shouldTranslate(text, this.targetLang as TranslateLang)) {
        if (!this.originalTextMap.has(textNode)) {
          this.originalTextMap.set(textNode, text);
        }
        if (textNode.parentElement) {
          this.observer?.observe(textNode.parentElement);
        }
      }
    }
  }

  private handleMutations(mutations: MutationRecord[]) {
    if (this.targetLang === 'off') return;

    mutations.forEach((m) => {
      if (m.type === 'childList') {
        m.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            this.scanAndObserve(node);
          } else if (node.nodeType === Node.TEXT_NODE) {
            const textNode = node as Text;
            const parent = textNode.parentElement;
            if (parent && !['SCRIPT', 'STYLE', 'CODE', 'PRE'].includes(parent.tagName)) {
              const text = textNode.nodeValue || '';
              if (text.trim() && shouldTranslate(text, this.targetLang as TranslateLang)) {
                this.originalTextMap.set(textNode, text);
                this.observer?.observe(parent);
              }
            }
          }
        });
      } else if (m.type === 'characterData') {
        const textNode = m.target as Text;
        if (this.translatedNodes.has(textNode)) return; // 忽略自己修改的

        const text = textNode.nodeValue || '';
        if (text.trim() && shouldTranslate(text, this.targetLang as TranslateLang)) {
          this.originalTextMap.set(textNode, text);
          if (textNode.parentElement) {
            this.observer?.observe(textNode.parentElement);
          }
        }
      }
    });
  }

  private handleIntersection(entries: IntersectionObserverEntry[]) {
    let hasNew = false;
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        const el = entry.target as HTMLElement;
        // 查找其子文本节点
        Array.from(el.childNodes).forEach((child) => {
          if (child.nodeType === Node.TEXT_NODE) {
            const textNode = child as Text;
            if (this.originalTextMap.has(textNode) && !this.translatedNodes.has(textNode)) {
              this.pendingNodes.add(textNode);
              hasNew = true;
            }
          }
        });
        this.observer?.unobserve(el);
      }
    });

    if (hasNew) {
      this.scheduleTranslation();
    }
  }

  private scheduleTranslation() {
    if (this.translating || this.pendingNodes.size === 0) {
      if (!this.translating && this.timer === null) {
        this.timer = window.setTimeout(() => this.processPending(), 500);
      }
      return;
    }

    if (this.timer) {
      window.clearTimeout(this.timer);
    }

    // 指数退避：连续失败时放慢重试节奏，避免打爆上游 API 触发限流
    const delay = this.failRounds > 0
      ? Math.min(BASE_BACKOFF_MS * Math.pow(2, this.failRounds - 1), MAX_BACKOFF_MS)
      : 500;
    this.timer = window.setTimeout(() => this.processPending(), delay);
  }

  private async processPending() {
    if (this.pendingNodes.size === 0 || this.targetLang === 'off') return;

    this.translating = true;
    this.pruneDetachedNodes();

    // 取出最多 50 个节点进行翻译，防止超限
    const batch = Array.from(this.pendingNodes).slice(0, MAX_BATCH);
    batch.forEach(n => this.pendingNodes.delete(n));

    // 提取纯文本（去除换行，因为翻译 API 遇到换行可能拆分导致不匹配）
    const nodeTextList = batch.map(n => ({
      node: n,
      original: this.originalTextMap.get(n) || '',
      clean: (this.originalTextMap.get(n) || '').replace(/\n/g, ' ')
    })).filter(item => item.clean.trim().length > 0);

    if (nodeTextList.length === 0) {
      this.translating = false;
      this.scheduleTranslation();
      return;
    }

    // ── 第一步：优先命中本地缓存（React 重渲染重建节点时秒级还原）──
    const cacheHits: Array<{ node: Text; dst: string }> = [];
    const uncached = nodeTextList.filter(item => {
      const dst = this.translationCache.get(item.clean.trim());
      if (dst !== undefined) {
        cacheHits.push({ node: item.node, dst });
        return false;
      }
      return true;
    });

    cacheHits.forEach(({ node, dst }) => {
      if (node.isConnected) {
        this.translatedNodes.add(node);
        node.nodeValue = dst;
      }
    });

    if (uncached.length === 0) {
      this.failRounds = 0;
      this.translating = false;
      this.scheduleTranslation();
      return;
    }

    const q = uncached.map(item => item.clean).join('\n');

    try {
      const result = await translateText(q, 'auto', this.targetLang as TranslateLang);

      // 建立翻译字典
      const dict = new Map<string, string>();
      result.trans_result.forEach(r => {
        dict.set(r.src.trim(), r.dst);
      });

      // 写入缓存 + 应用翻译
      uncached.forEach(item => {
        const dst = dict.get(item.clean.trim());
        if (dst) {
          const key = item.clean.trim();
          this.translationCache.set(key, dst);
          if (item.node.isConnected) {
            // 标记为已翻译，避免循环
            this.translatedNodes.add(item.node);
            item.node.nodeValue = dst;
          }
        }
      });

      // 缓存上限保护：超过 2000 条时清空最旧的一半
      if (this.translationCache.size > 2000) {
        let i = 0;
        const keysToDrop = Math.floor(this.translationCache.size / 2);
        for (const key of this.translationCache.keys()) {
          this.translationCache.delete(key);
          if (++i >= keysToDrop) break;
        }
      }

      this.failRounds = 0;
    } catch (e) {
      console.warn('Auto translation failed:', e);

      // 指数退避 + 最大重试：超过上限则放弃本批节点（保持原文显示），
      // 等待用户滚动到新内容时自然恢复，避免无限重试把上游 API 打爆
      if (this.failRounds < MAX_FAIL_ROUNDS) {
        this.failRounds++;
        batch.forEach(n => this.pendingNodes.add(n));
      } else {
        console.warn('[Translator] 放弃重试，等待新内容触发翻译');
      }
    } finally {
      this.translating = false;
      this.scheduleTranslation();
    }
  }
}

export const viewportTranslator = new ViewportTranslator();