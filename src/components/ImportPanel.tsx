import { useRef, useState } from 'react';
import type { Cue } from '../lib/srt';
import { formatTimecode } from '../lib/srt';

interface ImportPanelProps {
  nameA: string;
  nameB: string;
  textA: string;
  textB: string;
  cuesA: Cue[];
  cuesB: Cue[];
  aligning: boolean;
  onText(side: 'A' | 'B', text: string, name?: string): void;
  onAlign(): void;
  onSample(): void;
}

export function ImportPanel(props: ImportPanelProps) {
  const canAlign = props.cuesA.length > 0 && props.cuesB.length > 0 && !props.aligning;
  return (
    <section className="import">
      <div className="import-grid">
        <SourceCard
          side="A"
          title="字幕版本 A"
          name={props.nameA}
          text={props.textA}
          cues={props.cuesA}
          onText={props.onText}
        />
        <div className="import-vs">⇄</div>
        <SourceCard
          side="B"
          title="字幕版本 B"
          name={props.nameB}
          text={props.textB}
          cues={props.cuesB}
          onText={props.onText}
        />
      </div>
      <div className="import-actions">
        <button className="btn primary lg" disabled={!canAlign} onClick={props.onAlign}>
          {props.aligning ? '对齐中…' : '开始顺序对齐'}
        </button>
        <button className="btn ghost lg" onClick={props.onSample}>
          加载示例数据
        </button>
        {!canAlign && !props.aligning && (
          <span className="hint">请先为两个版本各导入一份 SRT（文件选择 / 拖拽 / 粘贴）</span>
        )}
      </div>
    </section>
  );
}

interface SourceCardProps {
  side: 'A' | 'B';
  title: string;
  name: string;
  text: string;
  cues: Cue[];
  onText(side: 'A' | 'B', text: string, name?: string): void;
}

function SourceCard({ side, title, name, text, cues, onText }: SourceCardProps) {
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const readFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => onText(side, String(reader.result ?? ''), file.name);
    reader.readAsText(file);
  };

  const range =
    cues.length > 0
      ? `${formatTimecode(cues[0].start)} ~ ${formatTimecode(cues[cues.length - 1].end)}`
      : '';

  return (
    <div
      className={`source-card ${drag ? 'drag' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const f = e.dataTransfer.files?.[0];
        if (f) readFile(f);
      }}
    >
      <header>
        <span className={`side-badge side-${side.toLowerCase()}`}>{side}</span>
        <strong>{title}</strong>
        <span className="file-name" title={name}>
          {name}
        </span>
      </header>
      <button type="button" className="drop" onClick={() => fileRef.current?.click()}>
        {cues.length > 0 ? (
          <>
            <span className="drop-ok">✓ 已解析 {cues.length} 条字幕</span>
            <span className="drop-range">{range}</span>
          </>
        ) : (
          <>
            <span className="drop-icon">⬆</span>
            <span>点击选择或拖入 .srt 文件</span>
          </>
        )}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".srt,.txt"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) readFile(f);
          e.target.value = '';
        }}
      />
      <textarea
        className="paste"
        placeholder="…或直接粘贴 SRT 内容"
        value={text}
        spellCheck={false}
        onChange={(e) => onText(side, e.target.value)}
      />
    </div>
  );
}
