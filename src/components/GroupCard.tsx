import type { ReactNode } from 'react';
import type { AlignGroup, GroupKind } from '../lib/align';
import type { GroupState, Resolution, TextChoice, TimeChoice } from '../lib/merge';
import { formatTimecode, type Cue } from '../lib/srt';

const KIND_LABEL: Record<GroupKind, string> = {
  '1:1': '一对一',
  '1:N': '一对多',
  'N:1': '多对一',
  'A-only': '仅 A',
  'B-only': '仅 B',
};

const KIND_CLS: Record<GroupKind, string> = {
  '1:1': 'k11',
  '1:N': 'k1n',
  'N:1': 'kn1',
  'A-only': 'ka',
  'B-only': 'kb',
};

interface GroupCardProps {
  index: number;
  group: AlignGroup;
  state: GroupState;
  cuesA: Cue[];
  cuesB: Cue[];
  suggestion: TextChoice;
  onResolve(patch: Partial<Resolution>): void;
}

export function GroupCard({ index, group, state, cuesA, cuesB, suggestion, onResolve }: GroupCardProps) {
  const res = state.resolution;
  const matched = group.aIdx.length > 0 && group.bIdx.length > 0;
  const onlySide = group.kind === 'A-only' ? 'A' : 'B';
  const cardCls = state.isConflict ? (state.resolved ? 'resolved' : 'unresolved') : '';

  return (
    <article className={`group-card ${cardCls}`} id={`group-${index}`}>
      <header className="g-head">
        <span className="g-idx">#{index + 1}</span>
        <span className={`kind ${KIND_CLS[group.kind]}`}>{KIND_LABEL[group.kind]}</span>
        {matched ? (
          <Confidence value={group.confidence} textSim={group.textSim} timeOverlap={group.timeOverlap} />
        ) : (
          <span className="conf-na">无对照</span>
        )}
        {matched && group.confidence < 0.5 && <span className="tag low">低置信</span>}
        <span className="spacer" />
        {state.isConflict &&
          (state.resolved ? <span className="tag ok">✓ 已解决</span> : <span className="tag warn">未解决</span>)}
        {state.isConflict && (
          <button
            className="btn-mini"
            title={`采用建议：文本取版本 ${suggestion}，时间轴取并集`}
            onClick={() => onResolve({ text: suggestion, time: 'union' })}
          >
            采纳建议
          </button>
        )}
      </header>

      <div className="g-cols">
        <CueColumn title="版本 A" cls="a" cues={cuesA} idxs={group.aIdx} />
        <CueColumn title="版本 B" cls="b" cues={cuesB} idxs={group.bIdx} />
      </div>

      {matched ? (
        <div className="g-controls">
          <div className="ctl-row">
            <span className="ctl-label">保留文本</span>
            <Pill value="A" current={res.text} onPick={(v: TextChoice) => onResolve({ text: v })}>
              版本 A
            </Pill>
            <Pill value="B" current={res.text} onPick={(v: TextChoice) => onResolve({ text: v })}>
              版本 B
            </Pill>
            <Pill value="custom" current={res.text} onPick={(v: TextChoice) => onResolve({ text: v })}>
              自定义
            </Pill>
          </div>
          {res.text === 'custom' && (
            <textarea
              className="custom-text"
              rows={2}
              placeholder="输入自定义文本…"
              value={res.customText}
              spellCheck={false}
              onChange={(e) => onResolve({ customText: e.target.value })}
            />
          )}
          <div className="ctl-row">
            <span className="ctl-label">时间轴</span>
            <Pill value="A" current={res.time} onPick={(v: TimeChoice) => onResolve({ time: v })}>
              版本 A
            </Pill>
            <Pill value="B" current={res.time} onPick={(v: TimeChoice) => onResolve({ time: v })}>
              版本 B
            </Pill>
            <Pill value="union" current={res.time} onPick={(v: TimeChoice) => onResolve({ time: v })}>
              并集
            </Pill>
            <Pill value="custom" current={res.time} onPick={(v: TimeChoice) => onResolve({ time: v })}>
              自定义
            </Pill>
          </div>
          {res.time === 'custom' && (
            <div className="ctl-row custom-time">
              <input
                value={res.customStart}
                placeholder="00:00:01,000"
                spellCheck={false}
                onChange={(e) => onResolve({ customStart: e.target.value })}
              />
              <span className="arrow">→</span>
              <input
                value={res.customEnd}
                placeholder="00:00:03,500"
                spellCheck={false}
                onChange={(e) => onResolve({ customEnd: e.target.value })}
              />
            </div>
          )}
        </div>
      ) : (
        <div className="g-controls">
          <div className="ctl-row">
            <span className="ctl-label">仅存在于版本 {onlySide}</span>
            <Pill value="keep" current={res.keep ? 'keep' : 'drop'} onPick={() => onResolve({ keep: true })}>
              保留
            </Pill>
            <Pill value="drop" current={res.keep ? 'keep' : 'drop'} onPick={() => onResolve({ keep: false })}>
              丢弃
            </Pill>
          </div>
        </div>
      )}
    </article>
  );
}

function Pill<T extends string>({
  value,
  current,
  onPick,
  children,
}: {
  value: T;
  current: T;
  onPick(v: T): void;
  children: ReactNode;
}) {
  return (
    <label className={`pill ${current === value ? 'active' : ''}`} onClick={() => onPick(value)}>
      <input type="radio" checked={current === value} readOnly />
      {children}
    </label>
  );
}

function Confidence({ value, textSim, timeOverlap }: { value: number; textSim: number; timeOverlap: number }) {
  const pct = Math.round(value * 100);
  const cls = value >= 0.8 ? 'high' : value >= 0.5 ? 'mid' : 'low';
  return (
    <div
      className="conf"
      title={`综合置信度 ${pct}%（文本相似度 ${Math.round(textSim * 100)}%，时间重叠 ${Math.round(timeOverlap * 100)}%）`}
    >
      <div className="conf-track">
        <div className={`conf-fill ${cls}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="conf-num">{pct}%</span>
    </div>
  );
}

function CueColumn({ title, cls, cues, idxs }: { title: string; cls: string; cues: Cue[]; idxs: number[] }) {
  return (
    <div className={`cue-col ${cls}`}>
      <div className="cue-col-title">{title}</div>
      {idxs.length === 0 ? (
        <div className="cue-empty">（无对应片段）</div>
      ) : (
        idxs.map((i) => (
          <div className="cue" key={i}>
            <div className="cue-meta">
              <span className="cue-no">#{cues[i].id + 1}</span>
              <span className="cue-time">
                {formatTimecode(cues[i].start)} → {formatTimecode(cues[i].end)}
              </span>
            </div>
            <div className="cue-text">{cues[i].text}</div>
          </div>
        ))
      )}
    </div>
  );
}
