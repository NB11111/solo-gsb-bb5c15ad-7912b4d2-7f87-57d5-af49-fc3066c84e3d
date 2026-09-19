import type { AlignGroup, GroupKind } from '../lib/align';
import type { GroupState } from '../lib/merge';

const KINDS: { kind: GroupKind; label: string; cls: string }[] = [
  { kind: '1:1', label: '一对一', cls: 'k11' },
  { kind: '1:N', label: '一对多', cls: 'k1n' },
  { kind: 'N:1', label: '多对一', cls: 'kn1' },
  { kind: 'A-only', label: '仅 A', cls: 'ka' },
  { kind: 'B-only', label: '仅 B', cls: 'kb' },
];

export function StatsBar({ groups, states }: { groups: AlignGroup[]; states: GroupState[] }) {
  const countOf = (kind: GroupKind) => groups.filter((g) => g.kind === kind).length;
  const conflicts = states.filter((s) => s.isConflict).length;
  const resolved = states.filter((s) => s.isConflict && s.resolved).length;
  const pct = conflicts === 0 ? 100 : Math.round((resolved / conflicts) * 100);

  return (
    <div className="stats">
      <div className="stat">
        <span className="stat-value">{groups.length}</span>
        <span className="stat-label">对齐组</span>
      </div>
      {KINDS.map((k) => (
        <div className="stat" key={k.kind}>
          <span className={`stat-value ${k.cls}`}>{countOf(k.kind)}</span>
          <span className="stat-label">{k.label}</span>
        </div>
      ))}
      <div className="stat progress-stat">
        <span className="stat-value">
          {resolved}
          <span className="stat-dim">/{conflicts}</span>
        </span>
        <span className="stat-label">冲突已解决</span>
        <div className="pbar">
          <div className={`pbar-fill ${pct === 100 ? 'done' : ''}`} style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}
