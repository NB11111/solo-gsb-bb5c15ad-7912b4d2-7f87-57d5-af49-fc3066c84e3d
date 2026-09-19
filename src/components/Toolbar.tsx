import type { TimeChoice } from '../lib/merge';

export type Filter = 'all' | 'unresolved' | 'low' | 'aonly' | 'bonly';

const TABS: { key: Filter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'unresolved', label: '未解决' },
  { key: 'low', label: '低置信度' },
  { key: 'aonly', label: '仅 A' },
  { key: 'bonly', label: '仅 B' },
];

interface ToolbarProps {
  filter: Filter;
  counts: Record<Filter, number>;
  onFilter(f: Filter): void;
  onBulkText(choice: 'A' | 'B' | 'longer'): void;
  onBulkTime(choice: TimeChoice): void;
  onResolveSuggested(): void;
  onOnlyKeep(side: 'A' | 'B', keep: boolean): void;
}

export function Toolbar(props: ToolbarProps) {
  return (
    <div className="toolbar">
      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`tab ${props.filter === t.key ? 'active' : ''}`}
            onClick={() => props.onFilter(t.key)}
          >
            {t.label}
            <span className="tab-count">{props.counts[t.key]}</span>
          </button>
        ))}
      </div>
      <div className="bulk">
        <span className="bulk-label">文本</span>
        <button className="btn sm" onClick={() => props.onBulkText('A')}>
          全用 A
        </button>
        <button className="btn sm" onClick={() => props.onBulkText('B')}>
          全用 B
        </button>
        <button className="btn sm" onClick={() => props.onBulkText('longer')}>
          用较长
        </button>
        <span className="bulk-sep" />
        <span className="bulk-label">时间轴</span>
        <button className="btn sm" onClick={() => props.onBulkTime('A')}>
          全用 A
        </button>
        <button className="btn sm" onClick={() => props.onBulkTime('B')}>
          全用 B
        </button>
        <button className="btn sm" onClick={() => props.onBulkTime('union')}>
          并集
        </button>
        <span className="bulk-sep" />
        <span className="bulk-label">单边片段</span>
        <button className="btn sm" onClick={() => props.onOnlyKeep('A', true)}>
          仅A 保留
        </button>
        <button className="btn sm" onClick={() => props.onOnlyKeep('A', false)}>
          仅A 丢弃
        </button>
        <button className="btn sm" onClick={() => props.onOnlyKeep('B', true)}>
          仅B 保留
        </button>
        <button className="btn sm" onClick={() => props.onOnlyKeep('B', false)}>
          仅B 丢弃
        </button>
        <span className="bulk-sep" />
        <button className="btn sm accent" onClick={props.onResolveSuggested}>
          按建议解决全部冲突
        </button>
      </div>
    </div>
  );
}
