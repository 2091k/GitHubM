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

class ViewportTranslator {
  private targetLang: TranslateLang | 'off' = 'off';
  private observer: IntersectionObserver | null = null;
  private mutationObserver: MutationObserver | null = null;
  
  private pendingNodes: Set<Text> = new Set();
  private translating: boolean = false;
  private originalTextMap: WeakMap<Text, string> = new WeakMap();
  private translatedSet: WeakSet<Text> = new WeakSet();
  private timer: number | null = null;

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

  private restoreAll() {
    // 由于 WeakMap 无法遍历，我们只能依靠 React 重新渲染或刷新页面来恢复
    // 但我们可以清除挂起的状态
    this.pendingNodes.clear();
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
      if (this.translatedSet.has(textNode)) continue;
      
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
        if (this.translatedSet.has(textNode)) return; // 忽略自己修改的

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
            if (this.originalTextMap.has(textNode) && !this.translatedSet.has(textNode)) {
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
    this.timer = window.setTimeout(() => this.processPending(), 500);
  }

  private async processPending() {
    if (this.pendingNodes.size === 0 || this.targetLang === 'off') return;
    
    this.translating = true;
    
    // 取出最多 50 个节点进行翻译，防止超限
    const batch = Array.from(this.pendingNodes).slice(0, 50);
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

    const q = nodeTextList.map(item => item.clean).join('\n');
    
    try {
      const result = await translateText(q, 'auto', this.targetLang as TranslateLang);
      
      // 建立翻译字典
      const dict = new Map<string, string>();
      result.trans_result.forEach(r => {
        dict.set(r.src.trim(), r.dst);
      });

      // 应用翻译
      nodeTextList.forEach(item => {
        const dst = dict.get(item.clean.trim());
        if (dst) {
          // 标记为已翻译，避免循环
          this.translatedSet.add(item.node);
          item.node.nodeValue = dst;
        }
      });
    } catch (e) {
      console.error('Auto translation failed:', e);
      // 发生错误时，将节点放回队列，稍后重试
      batch.forEach(n => this.pendingNodes.add(n));
    } finally {
      this.translating = false;
      this.scheduleTranslation();
    }
  }
}

export const viewportTranslator = new ViewportTranslator();
