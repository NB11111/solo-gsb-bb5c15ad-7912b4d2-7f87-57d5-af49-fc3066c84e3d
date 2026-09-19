import { useMemo, useState } from 'react';
import type { MergedCue } from '../lib/merge';
import { formatTimecode } from '../lib/srt';
import { displayWidth, type WrapOptions, type WrapResult } from '../lib/wrap';

const PAGE = 60;

interface WrapPanelProps {
  /** 合并后的字幕（未断行的当前文本） */
  cues: MergedCue[];
  /** 与 cues 对齐的断行试算结果 */
  results: WrapResult[];
  /** 已应用断行的 groupIndex 集合 */
  applied: ReadonlySet<number>;
  options: WrapOptions;
  onOptions(next: WrapOptions): void;
  onApply(groupIndex: number): void;
  onRestore(groupIndex: number): void;
  onApplyAll(): void;
  onRestoreAll(): void;
}

type EntryStatus = 'applied' | 'ready' | 'noop' | 'fail';

const STATUS_LABEL: Record<EntryStatus, string> = {
  applied: '已应用',
  ready: '可应用',
  noop: '无需断行',
  fail: '无法满足',
};

const STATUS_CLS: Record<EntryStatus, string> = {
  applied: 'ok',
  ready: 'go',
  noop: 'dim',
  fail: 'warn',
};

function statusOf(r: WrapResult, isApplied: boolean): EntryStatus {
  if (!r.ok) return 'fail';
  if (!r.changed) return 'noop';
  return isApplied ? 'applied' : 'ready';
}

export function WrapPanel(props: WrapPanelProps) {
  const { cues, results, applied, options } = props;
  const [shown, setShown] = useState(PAGE);

  const stats = useMemo(() => {
    const s = { applied: 0, ready: 0, noop: 0, fail: 0 };
    results.forEach((r, i) => {
      s[statusOf(r, applied.has(cues[i].groupIndex))]++;
    });
    return s;
  }, [results, applied, cues]);

  const setOpt = (patch: Partial<WrapOptions>) => props.onOptions({ ...options, ...patch });
  const parseNum = (raw: string, fallback: number, lo: number, hi: number) => {
    const v = parseInt(raw, 10);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  };

  return (
    <section className="wrap-panel">
      <div className="wrap-settings">
        <label>
          每行最大宽度
          <input
            type="number"
            min={2}
            max={200}
            value={options.maxWidth}
            onChange={(e) => setOpt({ maxWidth: parseNum(e.target.value, options.maxWidth, 2, 200) })}
          />
        </label>
        <label>
          最多行数
          <input
            type="number"
            min={1}
            max={10}
            value={options.maxLines}
            onChange={(e) => setOpt({ maxLines: parseNum(e.target.value, options.maxLines, 1, 10) })}
          />
        </label>
        <label className="wrap-lock">
          <input
            type="checkbox"
            checked={options.lockManualBreaks}
            onChange={(e) => setOpt({ lockManualBreaks: e.target.checked })}
          />
          锁定已有手工换行
        </label>
        <span className="spacer" />
        <button className="btn sm accent" disabled={stats.ready === 0} onClick={props.onApplyAll}>
          全部应用（{stats.ready}）
        </button>
        <button className="btn sm" disabled={stats.applied === 0} onClick={props.onRestoreAll}>
          全部恢复
        </button>
      </div>

      <div className="wrap-summary">
        共 {cues.length} 条 · 已应用 {stats.applied} · 待应用 {stats.ready} · 无需断行 {stats.noop}
        {stats.fail > 0 && <em> · {stats.fail} 条无法满足限制（保持原文）</em>}
        <span className="wrap-hint">宽度按字素簇计：全角 2、半角 1，HTML/ASS 标签保留不计宽</span>
      </div>

      <div className="wrap-list">
        {cues.length === 0 && <div className="empty">当前没有可断行的合并结果。</div>}
        {cues.slice(0, shown).map((cue, i) => {
          const r = results[i];
          const st = statusOf(r, applied.has(cue.groupIndex));
          const srcWidths = cue.text
            .split('\n')
            .map((l) => displayWidth(l))
            .join(' / ');
          return (
            <article className={`wrap-entry ${st}`} key={cue.groupIndex}>
              <div className="we-head">
                <span className="g-idx">#{i + 1}</span>
                <span className="cue-time">
                  {formatTimecode(cue.start)} → {formatTimecode(cue.end)}
                </span>
                <span className="spacer" />
                <span className={`tag ${STATUS_CLS[st]}`}>{STATUS_LABEL[st]}</span>
                {st === 'ready' && (
                  <button className="btn sm accent" onClick={() => props.onApply(cue.groupIndex)}>
                    应用
                  </button>
                )}
                {st === 'applied' && (
                  <button className="btn sm" onClick={() => props.onRestore(cue.groupIndex)}>
                    恢复
                  </button>
                )}
              </div>
              <div className="we-cols">
                <div className="we-col">
                  <div className="we-title">原文 · 宽 {srcWidths}</div>
                  <pre>{cue.text}</pre>
                </div>
                <div className="we-col">
                  {r.ok ? (
                    <>
                      <div className="we-title">
                        结果 · {r.lines.length} 行 · 宽 {r.widths.join(' / ')}
                      </div>
                      <pre className={st === 'applied' ? 'we-live' : ''}>{r.text}</pre>
                    </>
                  ) : (
                    <div className="we-fail">⚠ {r.reason}，未应用</div>
                  )}
                </div>
              </div>
            </article>
          );
        })}
        {cues.length > shown && (
          <button className="btn more" onClick={() => setShown((v) => v + PAGE)}>
            显示更多（剩余 {cues.length - shown} 条）
          </button>
        )}
      </div>
    </section>
  );
}
