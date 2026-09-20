import type { MergeIssue } from '../lib/merge';

interface ExportPanelProps {
  conflictCount: number;
  resolvedCount: number;
  unresolved: number;
  issues: MergeIssue[];
  autoFix: boolean;
  onAutoFix(v: boolean): void;
  cueCount: number;
  /** 识别出的滚动字幕链总数 */
  dedupChains: number;
  /** 已采纳消重的链数 */
  dedupApplied: number;
  /** 已采纳链累计节省的重复字符数 */
  dedupSaved: number;
  /** 已应用智能断行的条数 */
  wrapApplied: number;
  /** 无法满足断行限制、保持原文的条数 */
  wrapFailed: number;
  preview: string;
  canExport: boolean;
  onExport(): void;
  onJump(groupIndex: number): void;
}

export function ExportPanel(props: ExportPanelProps) {
  const { unresolved, issues, canExport } = props;
  let disabledReason = '';
  if (props.cueCount === 0) disabledReason = '没有可导出的字幕';
  if (unresolved > 0) disabledReason = `还有 ${unresolved} 个未解决冲突`;
  else if (issues.length > 0) disabledReason = `存在 ${issues.length} 个校验错误`;

  return (
    <aside className="export-panel">
      <h2 className="panel-title">合并与导出</h2>

      <ul className="checklist">
        <li className={unresolved === 0 ? 'pass' : 'fail'}>
          <span className="check-ic">{unresolved === 0 ? '✓' : '!'}</span>
          冲突解决：{props.resolvedCount}/{props.conflictCount}
          {unresolved > 0 && <em>（未处理冲突不得导出）</em>}
        </li>
        <li className={issues.length === 0 ? 'pass' : 'fail'}>
          <span className="check-ic">{issues.length === 0 ? '✓' : '!'}</span>
          时间单调性校验：{issues.length === 0 ? '通过' : `${issues.length} 个错误`}
        </li>
        <li className="pass">
          <span className="check-ic">✓</span>
          输出 {props.cueCount} 条字幕（导出时从 1 重新编号）
        </li>
        <li className={props.dedupChains === 0 ? 'pass' : props.dedupApplied > 0 ? 'pass' : 'warn'}>
          <span className="check-ic">{props.dedupChains === 0 || props.dedupApplied > 0 ? '✓' : '!'}</span>
          滚动字幕消重：已采纳 {props.dedupApplied}/{props.dedupChains} 链
          {props.dedupApplied > 0 && <em>（节省 {props.dedupSaved} 个重复字符）</em>}
          {props.dedupChains > 0 && props.dedupApplied === 0 && <em>（尚未采纳，预览为未消重结果）</em>}
        </li>
        <li className={props.wrapFailed === 0 ? 'pass' : 'warn'}>
          <span className="check-ic">{props.wrapFailed === 0 ? '✓' : '!'}</span>
          智能断行：已应用 {props.wrapApplied} 条
          {props.wrapFailed > 0 && <em>（{props.wrapFailed} 条无法满足限制，保持原文）</em>}
        </li>
      </ul>

      <label className="autofix">
        <input
          type="checkbox"
          checked={props.autoFix}
          onChange={(e) => props.onAutoFix(e.target.checked)}
        />
        自动修复时间重叠 / 非单调问题
      </label>

      {issues.length > 0 && (
        <div className="issues">
          {issues.map((it, i) => (
            <button key={i} className="issue" onClick={() => props.onJump(it.groupIndex)}>
              {it.message}
            </button>
          ))}
        </div>
      )}

      <h3 className="panel-sub">结果预览</h3>
      <pre className="preview">{props.preview || '（暂无内容）'}</pre>

      <button
        className="btn primary lg block"
        disabled={!canExport}
        title={canExport ? '下载 merged.srt' : disabledReason}
        onClick={props.onExport}
      >
        {canExport ? '下载合并 SRT' : disabledReason || '暂不可导出'}
      </button>
    </aside>
  );
}
