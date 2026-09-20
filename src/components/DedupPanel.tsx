import { useMemo, useState } from 'react';
import type { MergedCue } from '../lib/merge';
import { formatTimecode } from '../lib/srt';
import type { ScrollChain } from '../lib/dedup';

const PAGE = 60;

interface DedupPanelProps {
  /** 合并后的字幕（消重前的当前文本） */
  cues: MergedCue[];
  /** 在当前参数下识别出的候选链（按出现顺序） */
  chains: ScrollChain[];
  /** 已采纳链的链首下标集合 */
  adopted: ReadonlySet<number>;
  /** 最大相邻间隔（毫秒） */
  maxGapMs: number;
  /** 最小文本重叠（归一化字符数） */
  minOverlap: number;
  onMaxGapMs(v: number): void;
  onMinOverlap(v: number): void;
  onApply(headIndex: number): void;
  onRestore(headIndex: number): void;
  onApplyAll(): void;
  onRestoreAll(): void;
}

type ChainStatus = 'applied' | 'ready';

function formatGap(ms: number): string {
  if (ms <= 0) return `${ms} ms（时间重叠）`;
  return `${ms} ms`;
}

export function DedupPanel(props: DedupPanelProps) {
  const { cues, chains, adopted } = props;
  const [shown, setShown] = useState(PAGE);

  const stats = useMemo(() => {
    let applied = 0;
    let ready = 0;
    let savedTotal = 0;
    let savedAdopted = 0;
    let mergedAway = 0;
    for (const ch of chains) {
      const isAdopted = adopted.has(ch.members[0]);
      if (isAdopted) {
        applied++;
        savedAdopted += ch.savedChars;
        mergedAway += ch.members.length - 1;
      } else {
        ready++;
      }
      savedTotal += ch.savedChars;
    }
    return { applied, ready, savedTotal, savedAdopted, mergedAway };
  }, [chains, adopted]);

  const statusOf = (ch: ScrollChain): ChainStatus =>
    adopted.has(ch.members[0]) ? 'applied' : 'ready';

  const parseSec = (raw: string, fallback: number) => {
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) return fallback;
    // 允许 0~30 秒，步长 0.1，内部以毫秒存储
    return Math.round(Math.min(30, Math.max(0, v)) * 1000);
  };

  const gapSec = (props.maxGapMs / 1000).toFixed(1);

  return (
    <section className="dedup-panel">
      <div className="wrap-settings">
        <label>
          最大相邻间隔（秒）
          <input
            type="number"
            min={0}
            max={30}
            step={0.1}
            value={gapSec}
            onChange={(e) => props.onMaxGapMs(parseSec(e.target.value, props.maxGapMs))}
          />
        </label>
        <label>
          最小文本重叠（字）
          <input
            type="number"
            min={1}
            max={100}
            value={props.minOverlap}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              props.onMinOverlap(Number.isFinite(v) ? Math.min(100, Math.max(1, v)) : props.minOverlap);
            }}
          />
        </label>
        <span className="spacer" />
        <button className="btn sm accent" disabled={stats.ready === 0} onClick={props.onApplyAll}>
          全部采纳（{stats.ready}）
        </button>
        <button className="btn sm" disabled={stats.applied === 0} onClick={props.onRestoreAll}>
          全部恢复
        </button>
      </div>

      <div className="wrap-summary">
        共 {cues.length} 条 · 识别 {chains.length} 条滚动链 · 已采纳 {stats.applied} · 待采纳 {stats.ready}
        {' · '}可节省 {stats.savedTotal} 字符（已采纳 {stats.savedAdopted}，合并掉 {stats.mergedAway} 条）
        <span className="wrap-hint">
          相邻项按去标签 / 标点 / 空白后的最长后缀-前缀重叠连接；全局动态规划选择互不重叠的最优链
        </span>
      </div>

      <div className="wrap-list">
        {cues.length === 0 && <div className="empty">当前没有可消重的合并结果。</div>}
        {cues.length > 0 && chains.length === 0 && (
          <div className="empty">当前参数下没有识别到连续滚动字幕，可尝试调大间隔或调小最小重叠。</div>
        )}
        {chains.slice(0, shown).map((ch) => {
          const st = statusOf(ch);
          const head = ch.members[0];
          return (
            <article className={`wrap-entry dedup-entry ${st}`} key={head}>
              <div className="we-head">
                <span className="g-idx">
                  #{head + 1}
                  {ch.members.length > 2 ? `–${ch.members[ch.members.length - 1] + 1}` : ''}
                </span>
                <span className="cue-time">
                  {formatTimecode(ch.start)} → {formatTimecode(ch.end)}
                </span>
                <span className="tag go">连续 {ch.members.length} 条</span>
                <span className="tag ok">节省 {ch.savedChars} 字</span>
                <span className="spacer" />
                {st === 'ready' && (
                  <button className="btn sm accent" onClick={() => props.onApply(head)}>
                    采纳
                  </button>
                )}
                {st === 'applied' && (
                  <button className="btn sm" onClick={() => props.onRestore(head)}>
                    恢复
                  </button>
                )}
              </div>
              <div className="we-cols">
                <div className="we-col">
                  <div className="we-title">原链（{ch.members.length} 条）</div>
                  <div className="dedup-chain">
                    {ch.members.map((idx, t) => (
                      <div className="dedup-item" key={idx}>
                        <span className="cue-time">
                          #{idx + 1} · {formatTimecode(cues[idx].start)} → {formatTimecode(cues[idx].end)}
                        </span>
                        {t > 0 && (
                          <span className="dedup-meta">
                            重叠 {ch.overlaps[t - 1]} 字 · 间隔 {formatGap(ch.gaps[t - 1])}
                          </span>
                        )}
                        <pre>{cues[idx].text}</pre>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="we-col">
                  <div className="we-title">合并文本{st === 'applied' ? '（已采纳，用于预览与导出）' : ''}</div>
                  <pre className={st === 'applied' ? 'we-live' : ''}>{ch.mergedText}</pre>
                </div>
              </div>
            </article>
          );
        })}
        {chains.length > shown && (
          <button className="btn more" onClick={() => setShown((v) => v + PAGE)}>
            显示更多（剩余 {chains.length - shown} 条）
          </button>
        )}
      </div>
    </section>
  );
}
