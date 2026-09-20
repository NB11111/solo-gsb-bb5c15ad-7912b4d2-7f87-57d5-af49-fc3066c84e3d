import { useMemo, useState } from 'react';
import { alignCues, type AlignGroup } from './lib/align';
import {
  autoFixTimes,
  buildMergedCues,
  defaultStateFor,
  suggestTextChoice,
  TIME_FIXABLE,
  type GroupState,
  type Resolution,
  type TimeChoice,
} from './lib/merge';
import { SAMPLE_A, SAMPLE_B } from './lib/samples';
import { parseSrt, serializeSrt, type Cue } from './lib/srt';
import { applyScrollChains, findScrollChains, type ScrollOptions } from './lib/scroll';
import { smartWrap, type WrapOptions } from './lib/wrap';
import { DedupePanel } from './components/DedupePanel';
import { ExportPanel } from './components/ExportPanel';
import { GroupCard } from './components/GroupCard';
import { ImportPanel } from './components/ImportPanel';
import { StatsBar } from './components/StatsBar';
import { Toolbar, type Filter } from './components/Toolbar';
import { WrapPanel } from './components/WrapPanel';

const PAGE_SIZE = 80;

function download(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function App() {
  const [nameA, setNameA] = useState('版本A.srt');
  const [nameB, setNameB] = useState('版本B.srt');
  const [textA, setTextA] = useState('');
  const [textB, setTextB] = useState('');
  const cuesA = useMemo(() => parseSrt(textA), [textA]);
  const cuesB = useMemo(() => parseSrt(textB), [textB]);

  const [groups, setGroups] = useState<AlignGroup[] | null>(null);
  const [states, setStates] = useState<GroupState[]>([]);
  const [aligning, setAligning] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [autoFix, setAutoFix] = useState(false);

  // 智能断行：视图切换、参数与逐条应用状态（key 为 groupIndex）
  const [view, setView] = useState<'groups' | 'dedupe' | 'wrap'>('groups');
  const [wrapOpts, setWrapOpts] = useState<WrapOptions>({
    maxWidth: 42,
    maxLines: 2,
    lockManualBreaks: true,
  });
  const [wrapApplied, setWrapApplied] = useState<ReadonlySet<number>>(new Set());

  // 滚动字幕消重：参数（间隔毫秒 / 最小重叠字）与逐链采纳状态（key 为链 key）
  const [scrollOpts, setScrollOpts] = useState<ScrollOptions>({
    maxGapMs: 1000,
    minOverlap: 2,
  });
  const [scrollAccepted, setScrollAccepted] = useState<ReadonlySet<string>>(new Set());

  const runAlign = (a: Cue[], b: Cue[]) => {
    setAligning(true);
    // 让出一帧以渲染“对齐中”状态，再执行同步计算
    window.setTimeout(() => {
      const gs = alignCues(a, b);
      setGroups(gs);
      setStates(gs.map((g) => defaultStateFor(g, a, b)));
      setAligning(false);
      setFilter('all');
      setVisibleCount(PAGE_SIZE);
      setAutoFix(false);
      setView('groups');
      setWrapApplied(new Set());
      setScrollAccepted(new Set());
    }, 30);
  };

  const handleText = (side: 'A' | 'B', text: string, name?: string) => {
    if (side === 'A') {
      setTextA(text);
      if (name) setNameA(name);
    } else {
      setTextB(text);
      if (name) setNameB(name);
    }
  };

  const loadSample = () => {
    setNameA('示例A.srt');
    setNameB('示例B.srt');
    setTextA(SAMPLE_A);
    setTextB(SAMPLE_B);
    runAlign(parseSrt(SAMPLE_A), parseSrt(SAMPLE_B));
  };

  const reset = () => {
    setGroups(null);
    setStates([]);
    setView('groups');
    setWrapApplied(new Set());
    setScrollAccepted(new Set());
  };

  const updateResolution = (gi: number, patch: Partial<Resolution>) => {
    setStates((prev) =>
      prev.map((s, i) =>
        i === gi ? { ...s, resolved: true, resolution: { ...s.resolution, ...patch } } : s,
      ),
    );
  };

  const bulkText = (choice: 'A' | 'B' | 'longer') => {
    if (!groups) return;
    setStates((prev) =>
      prev.map((s, i) => {
        const g = groups[i];
        if (g.aIdx.length === 0 || g.bIdx.length === 0) return s;
        const text = choice === 'longer' ? suggestTextChoice(g, cuesA, cuesB) : choice;
        return { ...s, resolved: true, resolution: { ...s.resolution, text } };
      }),
    );
  };

  const bulkTime = (choice: TimeChoice) => {
    if (!groups) return;
    setStates((prev) =>
      prev.map((s, i) => {
        const g = groups[i];
        if (g.aIdx.length === 0 || g.bIdx.length === 0) return s;
        return { ...s, resolved: true, resolution: { ...s.resolution, time: choice } };
      }),
    );
  };

  const resolveSuggested = () => {
    if (!groups) return;
    setStates((prev) =>
      prev.map((s, i) =>
        s.isConflict
          ? {
              ...s,
              resolved: true,
              resolution: {
                ...s.resolution,
                text: suggestTextChoice(groups[i], cuesA, cuesB),
                time: 'union',
              },
            }
          : s,
      ),
    );
  };

  const setOnlyKeep = (side: 'A' | 'B', keep: boolean) => {
    if (!groups) return;
    const kind = side === 'A' ? 'A-only' : 'B-only';
    setStates((prev) =>
      prev.map((s, i) =>
        groups[i].kind === kind
          ? { ...s, resolved: true, resolution: { ...s.resolution, keep } }
          : s,
      ),
    );
  };

  const merged = useMemo(
    () => (groups ? buildMergedCues(groups, states, cuesA, cuesB) : null),
    [groups, states, cuesA, cuesB],
  );

  // 滚动字幕消重：在合并结果上识别滚动链，按已采纳链折叠后再进入断行/导出
  const scrollChains = useMemo(
    () => (merged ? findScrollChains(merged.cues, scrollOpts) : []),
    [merged, scrollOpts],
  );
  const dedupedCues = useMemo(() => {
    if (!merged) return [];
    return applyScrollChains(merged.cues, scrollChains, scrollAccepted);
  }, [merged, scrollChains, scrollAccepted]);
  const dedupStats = useMemo(() => {
    let appliedChains = 0;
    let saved = 0;
    let totalSaved = 0;
    for (const ch of scrollChains) {
      totalSaved += ch.saved;
      if (scrollAccepted.has(ch.key)) {
        appliedChains++;
        saved += ch.saved;
      }
    }
    return { chainCount: scrollChains.length, appliedChains, saved, totalSaved };
  }, [scrollChains, scrollAccepted]);

  const acceptChain = (key: string) =>
    setScrollAccepted((prev) => new Set(prev).add(key));
  const restoreChain = (key: string) =>
    setScrollAccepted((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  const acceptAllChains = (keys: string[]) =>
    setScrollAccepted((prev) => {
      const next = new Set(prev);
      keys.forEach((k) => next.add(k));
      return next;
    });
  const restoreAllChains = () => setScrollAccepted(new Set());

  // 智能断行：对每条（消重后）结果按当前参数试算；已应用且可满足限制的条目使用断行文本
  const wrapResults = useMemo(
    () => dedupedCues.map((c) => smartWrap(c.text, wrapOpts)),
    [dedupedCues, wrapOpts],
  );
  const wrappedCues = useMemo(() => {
    return dedupedCues.map((c, i) => {
      const r = wrapResults[i];
      return r.ok && wrapApplied.has(c.groupIndex) ? { ...c, text: r.text } : c;
    });
  }, [dedupedCues, wrapResults, wrapApplied]);
  const wrapStats = useMemo(() => {
    let appliedCount = 0;
    let failed = 0;
    dedupedCues.forEach((c, i) => {
      const r = wrapResults[i];
      if (!r.ok) failed++;
      else if (r.changed && wrapApplied.has(c.groupIndex)) appliedCount++;
    });
    return { appliedCount, failed };
  }, [dedupedCues, wrapResults, wrapApplied]);

  const applyWrap = (gi: number) => setWrapApplied((prev) => new Set(prev).add(gi));
  const restoreWrap = (gi: number) =>
    setWrapApplied((prev) => {
      const next = new Set(prev);
      next.delete(gi);
      return next;
    });
  const applyAllWrap = () => {
    const next = new Set<number>();
    dedupedCues.forEach((c, i) => {
      const r = wrapResults[i];
      if (r.ok && r.changed) next.add(c.groupIndex);
    });
    setWrapApplied(next);
  };
  const restoreAllWrap = () => setWrapApplied(new Set());

  const finalCues = useMemo(
    () => (autoFix ? autoFixTimes(wrappedCues) : wrappedCues),
    [wrappedCues, autoFix],
  );
  const issues = useMemo(
    () =>
      merged
        ? autoFix
          ? merged.issues.filter((i) => !TIME_FIXABLE.includes(i.kind))
          : merged.issues
        : [],
    [merged, autoFix],
  );

  const conflictCount = states.filter((s) => s.isConflict).length;
  const resolvedCount = states.filter((s) => s.isConflict && s.resolved).length;
  const unresolved = states.filter((s) => !s.resolved).length;
  const canExport = !!groups && unresolved === 0 && issues.length === 0 && finalCues.length > 0;

  const preview = useMemo(() => {
    if (!groups) return '';
    const full = serializeSrt(finalCues);
    return full.length > 20000
      ? `${full.slice(0, 20000)}\n…（共 ${finalCues.length} 条，预览已截断）`
      : full;
  }, [groups, finalCues]);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, unresolved: 0, low: 0, aonly: 0, bonly: 0 };
    if (!groups) return c;
    groups.forEach((g, i) => {
      c.all++;
      if (!states[i].resolved) c.unresolved++;
      if (g.aIdx.length > 0 && g.bIdx.length > 0 && g.confidence < 0.5) c.low++;
      if (g.kind === 'A-only') c.aonly++;
      if (g.kind === 'B-only') c.bonly++;
    });
    return c;
  }, [groups, states]);

  const filtered = useMemo(() => {
    if (!groups) return [];
    const out: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const matched = g.aIdx.length > 0 && g.bIdx.length > 0;
      const ok =
        filter === 'all' ||
        (filter === 'unresolved' && !states[i].resolved) ||
        (filter === 'low' && matched && g.confidence < 0.5) ||
        (filter === 'aonly' && g.kind === 'A-only') ||
        (filter === 'bonly' && g.kind === 'B-only');
      if (ok) out.push(i);
    }
    return out;
  }, [groups, states, filter]);

  const step = groups ? (unresolved > 0 ? 2 : 3) : cuesA.length > 0 && cuesB.length > 0 ? 1 : 0;

  const jumpToGroup = (gi: number) => {
    document.getElementById(`group-${gi}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">⇄</span>
          <div>
            <h1>字幕对齐合并工具</h1>
            <p>双版本 SRT 顺序对齐 · 冲突决策 · 合并导出</p>
          </div>
        </div>
        <ol className="steps">
          {['导入双版本', '顺序对齐', '解决冲突', '校验导出'].map((label, i) => (
            <li key={label} className={i < step ? 'done' : i === step ? 'active' : ''}>
              <span className="step-n">{i < step ? '✓' : i + 1}</span>
              {label}
            </li>
          ))}
        </ol>
      </header>

      {!groups ? (
        <ImportPanel
          nameA={nameA}
          nameB={nameB}
          textA={textA}
          textB={textB}
          cuesA={cuesA}
          cuesB={cuesB}
          aligning={aligning}
          onText={handleText}
          onAlign={() => runAlign(cuesA, cuesB)}
          onSample={loadSample}
        />
      ) : (
        <>
          <div className="import-summary">
            <span className="file-chip a">{nameA} · {cuesA.length} 条</span>
            <span className="swap">⇄</span>
            <span className="file-chip b">{nameB} · {cuesB.length} 条</span>
            <span className="spacer" />
            <button className="btn sm" onClick={reset}>
              重新导入
            </button>
          </div>

          <div className="layout">
            <main className="main-col">
              <StatsBar groups={groups} states={states} />
              <div className="tabs view-tabs">
                <button
                  className={`tab ${view === 'groups' ? 'active' : ''}`}
                  onClick={() => setView('groups')}
                >
                  对齐分组
                  <span className="tab-count">{groups.length}</span>
                </button>
                <button
                  className={`tab ${view === 'dedupe' ? 'active' : ''}`}
                  onClick={() => setView('dedupe')}
                >
                  滚动字幕消重
                  <span className="tab-count">{dedupStats.appliedChains}</span>
                </button>
                <button
                  className={`tab ${view === 'wrap' ? 'active' : ''}`}
                  onClick={() => setView('wrap')}
                >
                  智能断行
                  <span className="tab-count">{wrapStats.appliedCount}</span>
                </button>
              </div>
              {view === 'groups' ? (
                <>
                  <Toolbar
                    filter={filter}
                    counts={counts}
                    onFilter={(f) => {
                      setFilter(f);
                      setVisibleCount(PAGE_SIZE);
                    }}
                    onBulkText={bulkText}
                    onBulkTime={bulkTime}
                    onResolveSuggested={resolveSuggested}
                    onOnlyKeep={setOnlyKeep}
                  />
                  <div className="group-list">
                    {filtered.slice(0, visibleCount).map((gi) => (
                      <GroupCard
                        key={groups[gi].id}
                        index={gi}
                        group={groups[gi]}
                        state={states[gi]}
                        cuesA={cuesA}
                        cuesB={cuesB}
                        suggestion={suggestTextChoice(groups[gi], cuesA, cuesB)}
                        onResolve={(patch) => updateResolution(gi, patch)}
                      />
                    ))}
                    {filtered.length === 0 && (
                      <div className="empty">当前筛选条件下没有对齐组。</div>
                    )}
                    {filtered.length > visibleCount && (
                      <button className="btn more" onClick={() => setVisibleCount((v) => v + PAGE_SIZE)}>
                        显示更多（剩余 {filtered.length - visibleCount} 组）
                      </button>
                    )}
                  </div>
                </>
              ) : view === 'dedupe' ? (
                <DedupePanel
                  cues={merged?.cues ?? []}
                  options={scrollOpts}
                  onOptions={setScrollOpts}
                  accepted={scrollAccepted}
                  onAccept={acceptChain}
                  onRestore={restoreChain}
                  onAcceptAll={acceptAllChains}
                  onRestoreAll={restoreAllChains}
                />
              ) : (
                <WrapPanel
                  cues={dedupedCues}
                  results={wrapResults}
                  applied={wrapApplied}
                  options={wrapOpts}
                  onOptions={setWrapOpts}
                  onApply={applyWrap}
                  onRestore={restoreWrap}
                  onApplyAll={applyAllWrap}
                  onRestoreAll={restoreAllWrap}
                />
              )}
            </main>

            <ExportPanel
              conflictCount={conflictCount}
              resolvedCount={resolvedCount}
              unresolved={unresolved}
              issues={issues}
              autoFix={autoFix}
              onAutoFix={setAutoFix}
              cueCount={finalCues.length}
              dedupChains={dedupStats.chainCount}
              dedupApplied={dedupStats.appliedChains}
              dedupSaved={dedupStats.saved}
              wrapApplied={wrapStats.appliedCount}
              wrapFailed={wrapStats.failed}
              preview={preview}
              canExport={canExport}
              onExport={() => download('merged.srt', '\uFEFF' + serializeSrt(finalCues))}
              onJump={jumpToGroup}
            />
          </div>
        </>
      )}

      <footer className="foot">纯前端本地运行 · 字幕数据不会离开浏览器 · 对齐与校验均在本地完成</footer>
    </div>
  );
}
