// 工具改进工坊数据层（已脱离 Supabase 后端）
// 工具提案直接以 GitHub Issues 形式存储在项目仓库 qq5855144/GitHubM，
// 状态流转通过 label 实现（status/pending → status/approved → status/applied / status/rejected）。
// 优点：零后端、跨设备同步、可公开讨论。
import { getToken } from '@/services/github';
import i18n from "@/i18n";

const PROPOSAL_REPO = 'qq5855144/GitHubM';
const LABEL_PROPOSAL = 'ai-tool-proposal';
const LABEL_PENDING = 'status/pending';
const LABEL_APPROVED = 'status/approved';
const LABEL_REJECTED = 'status/rejected';
const LABEL_APPLIED = 'status/applied';

export interface Proposal {
  id: string;
  tool_name: string;
  issue: string;
  severity: 'low' | 'medium' | 'high';
  context: string | null;
  code_before: string | null;
  code_after: string | null;
  explanation: string | null;
  status: 'pending' | 'approved' | 'applied' | 'rejected';
  submitted_by: string | null;
  applied_at: string | null;
  created_at: string;
}

// ── GitHub API 基础封装 ─────────────────────────────────────────────────────

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

async function ghRequest(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: ghHeaders(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = '';
    try { msg = ((await res.json()) as { message?: string }).message ?? ''; } catch { /* ignore */ }
    throw new Error(`GitHub API ${res.status}${msg ? `: ${msg}` : ''}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ── Issue body 与 Proposal 互转 ──────────────────────────────────────────────

const FENCE = '```';

function escapeField(v: string): string {
  // 防注入：字段值中的 ``` 会被替换，避免破坏代码块结构
  return v.replace(/`{3,}/g, '``~');
}
function unescapeField(v: string): string {
  return v.replace(/``~/g, '```');
}

/** 将提案序列化为 Issue body（键值行 + Markdown 代码块） */
function proposalToBody(p: {
  tool_name: string; severity: string; issue: string;
  context?: string | null; explanation?: string | null;
  code_before?: string | null; code_after?: string | null;
}): string {
  const lines: string[] = [
    `tool: ${escapeField(p.tool_name)}`,
    `severity: ${p.severity}`,
    `issue: ${escapeField(p.issue)}`,
  ];
  if (p.context) lines.push(`context: ${escapeField(p.context)}`);
  if (p.explanation) lines.push(`explanation: ${escapeField(p.explanation)}`);
  lines.push('');
  if (p.code_before) lines.push('## code_before', '', FENCE, escapeField(p.code_before), FENCE, '');
  if (p.code_after) lines.push('## code_after', '', FENCE, escapeField(p.code_after), FENCE, '');
  return lines.join('\n');
}

/** 从 Issue body 解析出提案字段 */
function bodyToFields(body: string): {
  tool_name: string; severity: 'low' | 'medium' | 'high'; issue: string;
  context: string | null; explanation: string | null;
  code_before: string | null; code_after: string | null;
} {
  const fields: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const m = line.match(/^([a-z_]+): (.*)$/);
    if (m && ['tool', 'severity', 'issue', 'context', 'explanation'].includes(m[1])) {
      if (fields[m[1]] === undefined) fields[m[1]] = m[2];
    }
  }
  const extractCode = (name: string): string | null => {
    const re = new RegExp(`## ${name}\\s*\\n+${FENCE}\\n([\\s\\S]*?)${FENCE}`);
    const m = body.match(re);
    return m ? unescapeField(m[1]) : null;
  };
  const sev = (fields.severity ?? 'low') as 'low' | 'medium' | 'high';
  return {
    tool_name: unescapeField(fields.tool ?? 'unknown'),
    severity: ['low', 'medium', 'high'].includes(sev) ? sev : 'low',
    issue: unescapeField(fields.issue ?? ''),
    context: fields.context !== undefined ? unescapeField(fields.context) : null,
    explanation: fields.explanation !== undefined ? unescapeField(fields.explanation) : null,
    code_before: extractCode('code_before'),
    code_after: extractCode('code_after'),
  };
}

interface RawIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  user: { login: string } | null;
  labels: Array<{ name: string }>;
  created_at: string;
  closed_at: string | null;
}

function issueToProposal(issue: RawIssue): Proposal {
  const fields = bodyToFields(issue.body ?? '');
  const labelNames = issue.labels.map(l => l.name);
  let status: Proposal['status'] = 'pending';
  if (labelNames.includes(LABEL_APPLIED)) status = 'applied';
  else if (labelNames.includes(LABEL_REJECTED)) status = 'rejected';
  else if (labelNames.includes(LABEL_APPROVED)) status = 'approved';
  return {
    id: String(issue.number),
    tool_name: fields.tool_name,
    issue: fields.issue,
    severity: fields.severity,
    context: fields.context,
    code_before: fields.code_before,
    code_after: fields.code_after,
    explanation: fields.explanation,
    status,
    submitted_by: issue.user?.login ?? null,
    applied_at: status === 'applied' ? issue.closed_at : null,
    created_at: issue.created_at,
  };
}

// ── 查询 ────────────────────────────────────────────────────────────────────

/** 拉取全部提案（按创建时间降序） */
export async function fetchProposals(): Promise<Proposal[]> {
  const token = getToken();
  if (!token) throw new Error(i18n.t('未登录，请先设置 GitHub Token'));
  const issues = await ghRequest(
    'GET',
    `/repos/${PROPOSAL_REPO}/issues?labels=${LABEL_PROPOSAL}&state=all&per_page=100`,
    token,
  ) as RawIssue[];
  return (Array.isArray(issues) ? issues : [])
    .map(issueToProposal)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** 按状态过滤提案 */
export async function fetchProposalsByStatus(status: 'all' | Proposal['status']): Promise<Proposal[]> {
  const all = await fetchProposals();
  if (status === 'all') return all;
  return all.filter(p => p.status === status);
}

/** 提案统计 */
export async function fetchProposalStats(): Promise<{
  total: number; pending: number; approved: number; applied: number; rejected: number;
  high: number; medium: number; low: number;
}> {
  const all = await fetchProposals();
  const stats = { total: all.length, pending: 0, approved: 0, applied: 0, rejected: 0, high: 0, medium: 0, low: 0 };
  for (const p of all) {
    stats[p.status] += 1;
    stats[p.severity] += 1;
  }
  return stats;
}

// ── 状态流转 ────────────────────────────────────────────────────────────────

async function addLabel(issueNumber: string, label: string): Promise<void> {
  const token = getToken();
  if (!token) throw new Error(i18n.t('未登录，请先设置 GitHub Token'));
  await ghRequest('POST', `/repos/${PROPOSAL_REPO}/issues/${issueNumber}/labels`, token, { labels: [label] });
}

async function removeLabel(issueNumber: string, label: string): Promise<void> {
  const token = getToken();
  if (!token) throw new Error(i18n.t('未登录，请先设置 GitHub Token'));
  await ghRequest('DELETE', `/repos/${PROPOSAL_REPO}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`, token);
}

/** 审核通过 */
export async function approveProposal(id: string): Promise<void> {
  await addLabel(id, LABEL_APPROVED);
  await removeLabel(id, LABEL_PENDING);
}

/** 拒绝 */
export async function rejectProposal(id: string): Promise<void> {
  await addLabel(id, LABEL_REJECTED);
  await removeLabel(id, LABEL_PENDING);
}

/** 标记应用（并关闭 Issue） */
export async function applyProposal(id: string): Promise<void> {
  const token = getToken();
  if (!token) throw new Error(i18n.t('未登录，请先设置 GitHub Token'));
  await addLabel(id, LABEL_APPLIED);
  await removeLabel(id, LABEL_PENDING).catch(() => { /* 可能已是 approved 状态 */ });
  await removeLabel(id, LABEL_APPROVED).catch(() => { /* ignore */ });
  await ghRequest('PATCH', `/repos/${PROPOSAL_REPO}/issues/${id}`, token, { state: 'closed' });
}

// ── 提交（供 AI Agent 的 report_tool_issue / propose_tool_fix 工具调用）──────

export interface SubmitProposalInput {
  tool_name: string;
  issue: string;
  severity: 'low' | 'medium' | 'high';
  context?: string | null;
  explanation?: string | null;
  code_before?: string | null;
  code_after?: string | null;
}

/** 提交新提案（创建带标签的 Issue） */
export async function submitProposal(input: SubmitProposalInput): Promise<string> {
  const token = getToken();
  if (!token) throw new Error(i18n.t('未登录，请先设置 GitHub Token'));
  const title = `[工具提案] ${input.tool_name}: ${input.issue.slice(0, 80)}`;
  const body = proposalToBody(input);
  const issue = await ghRequest('POST', `/repos/${PROPOSAL_REPO}/issues`, token, {
    title,
    body,
    labels: [LABEL_PROPOSAL, LABEL_PENDING],
  }) as RawIssue;
  return String(issue.number);
}