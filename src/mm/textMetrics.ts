import { wikiLabel } from './md';
let context: CanvasRenderingContext2D | null = null;
export const inlinePattern = /(!?\[\[[^\]\n]*\]\]|\*\*\*[^*\n]+\*\*\*|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_)/g;
export function textPixels(text: string, size = 13, bold = false, italic = false, family?: string): number {
  context ||= document.createElement('canvas').getContext('2d');
  if (!context) return Array.from(text).length * size * 0.55;
  context.font = `${italic ? 'italic ' : ''}${bold ? '700 ' : ''}${size}px ${family || getComputedStyle(document.body).fontFamily || 'sans-serif'}`;
  return context.measureText(text).width;
}
export function characterLimitPixels(chars: number, size = 13, family?: string): number {
  const sample = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЭЮЯабвгдежзийклмнопрстуфхцчшщэюя0123456789';
  return Math.max(1, chars) * textPixels(sample, size, false, false, family) / sample.length;
}
export function inlinePixels(text: string, size = 13, bold = false, italic = false): number {
  return text.split(inlinePattern).reduce((sum, part) => {
    const link = /^!?\[\[([^\]\n]*)\]\]$/.exec(part);
    const both = /^\*\*\*([^*]+)\*\*\*$/.exec(part);
    const b = /^(?:\*\*([^*]+)\*\*|__([^_]+)__)$/.exec(part);
    const i = /^(?:\*([^*]+)\*|_([^_]+)_)$/.exec(part);
    return sum + textPixels(link ? wikiLabel(link[1]) : both?.[1] || b?.[1] || b?.[2] || i?.[1] || i?.[2] || part, size, bold || !!both || !!b, italic || !!both || !!i);
  }, 0);
}
export function wrapPixels(text: string, limit: number, size = 13, bold = false, italic = false): string[] {
  const out: string[] = [];
  const measure = (s: string) => inlinePixels(s, size, bold, italic);
  for (const original of text.replace(/\r\n/g, '\n').split('\n')) {
    let line = '', space = false;
    const flush = () => { if (line) out.push(line); line = ''; space = false; };
    const append = (word: string, prefix = '', suffix = '') => {
      if (line && measure(line + (space ? ' ' : '') + prefix + word + suffix) > limit) flush();
      let chars = Array.from(word);
      while (chars.length) {
        let count = 0;
        while (count < chars.length && measure(line + (space && line ? ' ' : '') + prefix + chars.slice(0, count + 1).join('') + suffix) <= limit) count++;
        count = Math.max(1, count);
        line += (space && line ? ' ' : '') + prefix + chars.splice(0, count).join('') + suffix;
        space = false;
        if (chars.length) flush();
      }
    };
    for (const part of original.split(inlinePattern).filter(Boolean)) {
      const link = /^(!?\[\[)([^\]\n]*)(\]\])$/.exec(part);
      const emphasis = /^(\*\*\*|\*\*|__|\*|_)(.*)\1$/.exec(part);
      if (link) { const target = link[2].split('|')[0]; append(wikiLabel(link[2]), link[1] + target + '|', ']]'); continue; }
      for (const token of (emphasis ? emphasis[2] : part).split(/(\s+)/)) {
        if (/^\s+$/.test(token)) space = true;
        else if (token) append(token, emphasis?.[1] || '', emphasis?.[1] || '');
      }
    }
    if (line) flush(); else if (!original.trim()) out.push('');
  }
  return out.length ? out : [''];
}
