// 访问统计工具模块（纯本地版，已脱离 Supabase 后端）
// 访问记录保存在本机 localStorage，统计本机 PV/UV（UV 以安装实例计）
// 不再上报任何服务器，用户隐私完全本地化

const STORE_KEY = 'visit_stats_local'; // 本地统计存储键
const LAST_VISIT_KEY = 'visit_last_path'; // 上一次记录的路径（用于去重节流）
const VISIT_DEBOUNCE_MS = 2000; // 同一页面最小记录间隔 2 秒（防止高频触发）

// ── 本地存储结构 ─────────────────────────────────────────────────────────
interface VisitDayRecord {
  pv: number;        // 当日总访问次数
  paths: Record<string, number>; // 各页面访问次数
}

interface VisitStore {
  /** 本机唯一实例 ID（作为 UV 标识） */
  deviceId: string;
  /** date(YYYY-MM-DD) -> 当日记录 */
  days: Record<string, VisitDayRecord>;
}

function loadStore(): VisitStore {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<VisitStore>;
      if (parsed && typeof parsed === 'object') {
        return {
          deviceId: typeof parsed.deviceId === 'string' ? parsed.deviceId : genDeviceId(),
          days: parsed.days && typeof parsed.days === 'object' ? parsed.days : {},
        };
      }
    }
  } catch { /* ignore */ }
  return { deviceId: genDeviceId(), days: {} };
}

function genDeviceId(): string {
  const id = `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return id;
}

function saveStore(store: VisitStore): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch { /* 存储空间不足时静默失败 */ }
}

function todayKey(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// ── 记录一次页面访问（写入本地存储）──────────────────────────────────────
export async function recordVisit(pagePath?: string): Promise<void> {
  try {
    const path = pagePath ?? (typeof location !== 'undefined' ? location.pathname || '/' : '/');

    // 节流：同一页面 2 秒内重复触发则跳过（避免路由快速切换、刷新时重复记录）
    try {
      const last = sessionStorage.getItem(LAST_VISIT_KEY);
      if (last) {
        const [lastPath, lastTime] = last.split('|');
        if (lastPath === path && Date.now() - parseInt(lastTime, 10) < VISIT_DEBOUNCE_MS) {
          return; // 同一页面且间隔 < 2s，跳过
        }
      }
      sessionStorage.setItem(LAST_VISIT_KEY, `${path}|${Date.now()}`);
    } catch {
      // sessionStorage 不可用时忽略节流
    }

    const store = loadStore();
    const key = todayKey();
    const day = store.days[key] ?? { pv: 0, paths: {} };
    day.pv += 1;
    day.paths[path] = (day.paths[path] ?? 0) + 1;
    store.days[key] = day;
    saveStore(store);
  } catch (e) {
    // 任何失败都仅 console.warn，不阻断业务
    console.warn('[visitStats] recordVisit 失败:', e);
  }
}

// ── 类型定义（供 SettingsPage 使用）──────────────────────────────────────
export interface DailyStats {
  date:  string;   // YYYY-MM-DD
  label: string;   // M/D 格式
  pv:    number;
  uv:    number;
}

export interface VisitSummary {
  todayPv:    number;  // 今日 PV
  todayUv:    number;  // 今日 UV
  totalPv:    number;  // 近 N 天总 PV
  totalUv:    number;  // 近 N 天总 UV（本机实例去重，即 1）
  allTimePv:  number;  // 历史累计总 PV
  allTimeUv:  number;  // 历史累计总 UV
  activeDays: number;  // 有访问的天数
}

export interface VisitStatsResult {
  trend:   DailyStats[];
  summary: VisitSummary;
}

// ── 查询近 N 天统计数据（从本地存储读取）────────────────────────────────
export async function fetchVisitStats(days = 7): Promise<VisitStatsResult> {
  const store = loadStore();
  const trend: DailyStats[] = [];
  let totalPv = 0;
  let activeDays = 0;
  let allTimePv = 0;

  // 全量统计 allTime
  for (const day of Object.values(store.days)) {
    allTimePv += day.pv;
    if (day.pv > 0) activeDays += 1;
  }

  // 生成近 N 天趋势（含无访问的空白天，保证图表连续）
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const pv = store.days[key]?.pv ?? 0;
    if (pv > 0) totalPv += pv;
    trend.push({
      date: key,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      pv,
      uv: pv > 0 ? 1 : 0,
    });
  }

  const todayPv = store.days[todayKey()]?.pv ?? 0;

  return {
    trend,
    summary: {
      todayPv,
      todayUv: todayPv > 0 ? 1 : 0,
      totalPv,
      totalUv: totalPv > 0 ? 1 : 0,
      allTimePv,
      allTimeUv: allTimePv > 0 ? 1 : 0,
      activeDays,
    },
  };
}
