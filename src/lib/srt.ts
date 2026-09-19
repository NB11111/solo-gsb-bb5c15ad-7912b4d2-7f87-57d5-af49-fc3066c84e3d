/** SRT 字幕的解析、时间码处理与序列化。 */

export interface Cue {
  /** 解析后按顺序重新分配的 0 基索引 */
  id: number;
  /** 开始时间（毫秒） */
  start: number;
  /** 结束时间（毫秒） */
  end: number;
  /** 字幕文本（可能包含换行） */
  text: string;
}

const TIME_IN_LINE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/g;

/** 解析 "HH:MM:SS,mmm"（也兼容 "MM:SS,mmm"、小数点、1~3 位毫秒），失败返回 null。 */
export function parseTimecode(input: string): number | null {
  const m = input.trim().match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/);
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const min = parseInt(m[2], 10);
  const sec = parseInt(m[3], 10);
  if (min > 59 || sec > 59) return null;
  const ms = parseInt(m[4].padEnd(3, '0'), 10);
  return ((h * 60 + min) * 60 + sec) * 1000 + ms;
}

/** 毫秒 → "HH:MM:SS,mmm"。 */
export function formatTimecode(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const p2 = (v: number) => String(v).padStart(2, '0');
  const h = Math.floor(t / 3_600_000);
  const min = Math.floor((t % 3_600_000) / 60_000);
  const sec = Math.floor((t % 60_000) / 1000);
  const milli = t % 1000;
  return `${p2(h)}:${p2(min)}:${p2(sec)},${String(milli).padStart(3, '0')}`;
}

/** 解析 SRT 文本为 cue 列表，忽略序号块编号，按出现顺序重新编号（0 基）。 */
export function parseSrt(content: string): Cue[] {
  const text = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const blocks = text.split(/\n\s*\n/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx === -1) continue;
    TIME_IN_LINE.lastIndex = 0;
    const matches = [...lines[timeIdx].matchAll(TIME_IN_LINE)];
    if (matches.length < 2) continue;
    const toMs = (mm: RegExpMatchArray) =>
      ((+mm[1]) * 3600 + (+mm[2]) * 60 + (+mm[3])) * 1000 + +mm[4].padEnd(3, '0');
    const start = toMs(matches[0]);
    const end = toMs(matches[1]);
    const textLines = lines.slice(timeIdx + 1);
    if (textLines.length === 0) continue;
    cues.push({ id: cues.length, start, end, text: textLines.join('\n') });
  }
  return cues;
}

/** 序列化为标准 SRT 文本，序号从 1 重新编排。 */
export function serializeSrt(cues: { start: number; end: number; text: string }[]): string {
  return (
    cues
      .map((c, i) => `${i + 1}\n${formatTimecode(c.start)} --> ${formatTimecode(c.end)}\n${c.text}`)
      .join('\n\n') + '\n'
  );
}
