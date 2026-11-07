// A small Markdown renderer for the manual (docs/manual/*.md): headings, paragraphs, lists, tables,
// bold, code, links and a "> " note. Nothing else, so there is nothing else to get wrong. Text is
// escaped; the manual is ours, but the renderer still never trusts it.
import { esc, Html, raw } from './html.js';

function inline(s: string): string {
  let out = esc(s);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, href) => (/^(\/|https?:\/\/|#)/.test(href) ? `<a href="${href}">${text}</a>` : text));
  return out;
}

export function markdown(src: string): Html {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  const para: string[] = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para.length = 0; } };
  while (i < lines.length) {
    const line = lines[i];
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { flush(); const lvl = h[1].length; const text = h[2].trim(); const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); out.push(`<h${lvl} id="${id}">${inline(text)}</h${lvl}>`); i++; continue; }
    if (/^\s*$/.test(line)) { flush(); i++; continue; }
    if (/^---+$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
    if (/^>\s?/.test(line)) { flush(); const q: string[] = []; while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, '')); i++; } out.push(`<div class="note">${inline(q.join(' '))}</div>`); continue; }
    if (/^\|/.test(line)) {
      flush(); const rows: string[][] = [];
      while (i < lines.length && /^\|/.test(lines[i])) { const cells = lines[i].replace(/^\||\|$/g, '').split('|').map((c) => c.trim()); if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells); i++; }
      const [head, ...body] = rows;
      out.push(`<div class="tbl" tabindex="0"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const ordered = /\d/.test(li[2]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (m && m[1].length === li[1].length) { items.push(m[3]); i++; continue; }
        // A continuation line indented under the item.
        if (items.length && /^\s{2,}\S/.test(lines[i]) && !/^(\s*)([-*]|\d+\.)\s+/.exec(lines[i])) { items[items.length - 1] += ' ' + lines[i].trim(); i++; continue; }
        break;
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    para.push(line.trim()); i++;
  }
  flush();
  return raw(out.join('\n'));
}

/** The first "# " heading, for the page title. */
export function titleOf(src: string): string {
  const m = /^#\s+(.*)$/m.exec(src);
  return m ? m[1].trim() : 'Manual';
}
