// Tiny HTML templating: html`...` escapes every interpolated value unless it is
// already Html (from html`` or raw()). Arrays are joined. null/undefined/false print nothing.

export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export function raw(s: string): Html {
  return new Html(s);
}

export function esc(v: unknown): string {
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function render(v: unknown): string {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Html(out);
}
