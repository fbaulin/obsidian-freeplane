/** Markdown features stored as Freeplane XHTML. */
export function tableCells(line: string): string[] {
  const cells: string[] = []; let cell = "", wiki = 0, code = false;
  line = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && i + 1 < line.length) { cell += c + line[++i]; continue; }
    if (c === "`") code = !code;
    if (!code && line.slice(i, i + 2) === "[[") wiki++;
    if (!code && line.slice(i, i + 2) === "]]") wiki = Math.max(0, wiki - 1);
    if (c === "|" && !code && !wiki) { cells.push(cell.trim()); cell = ""; } else cell += c;
  }
  cells.push(cell.trim()); return cells;
}
export function tableStart(lines: string[], i: number): boolean {
  if (i + 1 >= lines.length || !lines[i].includes("|")) return false;
  const cells = tableCells(lines[i + 1]);
  return cells.length === tableCells(lines[i]).length && cells.every(c => /^:?-{3,}:?$/.test(c));
}
export function needsRichStorage(source: string): boolean {
  const lines = source.split("\n");
  return /`/.test(source) || /~~[^\n]+?~~/.test(source) || lines.some((_, i) => tableStart(lines, i));
}
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function inline(source: string): string {
  // Keep code and link targets intact while converting formatting outside them.
  return source.split(/(`+[^`]*`+|!?\[\[[\s\S]*?\]\])/g).map(part => {
    if (/^`/.test(part)) {
      const code = /^(`+)([\s\S]*?)\1$/.exec(part);
      return code ? '<code>' + escape(code[2]) + '</code>' : escape(part);
    }
    if (/^!?\[\[/.test(part)) return escape(part);
    return escape(part).replace(/~~(.+?)~~/g, '<strike>$1</strike>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  }).join("");
}
export function markdownHtml(source: string): string {
  const lines = source.split("\n"), blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const fence = /^\s*(`{3,})(.*)$/.exec(lines[i]);
    if (fence) {
      const code: string[] = [], language = fence[2].trim();
      while (++i < lines.length && !new RegExp('^\\s*`{' + fence[1].length + ',}\\s*$').test(lines[i])) code.push(lines[i]);
      blocks.push('<pre><code' + (language ? ' data-language="' + escape(language) + '"' : '') + '>' + escape(code.join('\n')) + '</code></pre>');
      continue;
    }
    if (!tableStart(lines, i)) { blocks.push(`<p>${inline(lines[i])}</p>`); continue; }
    const headers = tableCells(lines[i]), separators = tableCells(lines[++i]);
    const align = separators.map(s => s.startsWith(":") ? (s.endsWith(":") ? "center" : "left") : (s.endsWith(":") ? "right" : ""));
    const row = (cells: string[], tag: string) => '<tr>' + headers.map((_, j) => `<${tag}${align[j] ? ` align="${align[j]}"` : ''}>${inline((cells[j] || '').replace(/\\\|/g, '|'))}</${tag}>`).join('') + '</tr>';
    let html = '<table><thead>' + row(headers, 'th') + '</thead><tbody>';
    while (i + 1 < lines.length && lines[i + 1].trim() && lines[i + 1].includes('|')) html += row(tableCells(lines[++i]), 'td');
    blocks.push(html + '</tbody></table>');
  }
  return '<html><head></head><body>' + blocks.join('') + '</body></html>';
}
export function htmlMarkdown(body: Element): string {
  const walk = (node: Node): string => {
    if (node.nodeType === 3 || node.nodeType === 4) return node.nodeValue || '';
    if (node.nodeType !== 1) return '';
    const el = node as Element, tag = el.nodeName.toLowerCase();
    const inner = () => Array.from(el.childNodes).map(walk).join('');
    if (tag === 'pre') {
      const code = el.querySelector('code') || el;
      const raw = code.textContent || '';
      const fence = '`'.repeat(Math.max(3, ...Array.from(raw.matchAll(/`+/g), m => m[0].length + 1)));
      return fence + (code.getAttribute('data-language') || '') + '\n' + raw + '\n' + fence + '\n';
    }
    if (tag === 'code') {
      const raw = el.textContent || '';
      const marker = '`'.repeat(Math.max(1, ...Array.from(raw.matchAll(/`+/g), m => m[0].length + 1)));
      return marker + raw + marker;
    }
    if (tag === 'table') {
      const rows = Array.from(el.querySelectorAll('tr')).map(row => Array.from(row.children).filter(c => /^(th|td)$/i.test(c.tagName)));
      if (!rows.length) return '';
      const encode = (cell: Element) => walk(cell).trim().replace(/\n/g, '<br/>').replace(/\|/g, '\\|');
      const width = Math.max(...rows.map(r => r.length));
      const line = (cells: string[]) => '| ' + Array.from({length: width}, (_, i) => cells[i] || '').join(' | ') + ' |';
      const separator = rows[0].map(c => { const a = c.getAttribute('align'); return a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---'; });
      return [line(rows[0].map(encode)), line(separator), ...rows.slice(1).map(r => line(r.map(encode)))].join('\n') + '\n';
    }
    if (/^(strike|s|del)$/.test(tag)) return '~~' + inner() + '~~';
    if (/^(b|strong)$/.test(tag)) return '**' + inner() + '**';
    if (/^(i|em)$/.test(tag)) return '*' + inner() + '*';
    if (tag === 'br') return '\n';
    if (tag === 'p' || tag === 'div') return inner() + '\n';
    return inner();
  };
  return Array.from(body.childNodes).map(walk).join('').replace(/^\n|\n$/g, '');
}
