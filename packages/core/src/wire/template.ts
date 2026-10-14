/**
 * Perforce message templates (`fmt0`) name the arguments the server substituted,
 * for example `Can't clobber writable file %file%`. Matching the formatted text
 * against its template recovers those arguments without English patterns.
 *
 * Supported syntax: `%name%` arguments, `%'text'%` literal text, and
 * `[first|second]` conditionals, where `[text]` alone means optional text.
 */

type TemplateNode =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'arg'; readonly name: string }
  | { readonly kind: 'choice'; readonly first: TemplateNode[]; readonly second: TemplateNode[] };

interface CompiledTemplate {
  readonly pattern: RegExp;
  readonly names: readonly string[];
}

const compiled = new Map<string, CompiledTemplate | null>();

function parse(template: string): TemplateNode[] | null {
  let index = 0;
  const sequence = (closers: string): TemplateNode[] | null => {
    const nodes: TemplateNode[] = [];
    let text = '';
    const flush = () => {
      if (text) nodes.push({ kind: 'text', value: text });
      text = '';
    };
    while (index < template.length) {
      const char = template[index]!;
      if (closers.includes(char)) break;
      if (char === '%') {
        const end = template.indexOf('%', index + 1);
        if (end < 0) return null;
        const body = template.slice(index + 1, end);
        index = end + 1;
        if (body === '') {
          text += '%';
        } else if (body.startsWith("'") && body.endsWith("'") && body.length >= 2) {
          text += body.slice(1, -1);
        } else {
          flush();
          nodes.push({ kind: 'arg', name: body });
        }
        continue;
      }
      if (char === '[') {
        index += 1;
        flush();
        const first = sequence('|]');
        if (first === null) return null;
        let second: TemplateNode[] = [];
        if (template[index] === '|') {
          index += 1;
          const rest = sequence(']');
          if (rest === null) return null;
          second = rest;
        }
        if (template[index] !== ']') return null;
        index += 1;
        nodes.push({ kind: 'choice', first, second });
        continue;
      }
      text += char;
      index += 1;
    }
    flush();
    return nodes;
  };
  const nodes = sequence('');
  return nodes !== null && index === template.length ? nodes : null;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toPattern(nodes: readonly TemplateNode[], names: string[]): string {
  return nodes.map((node) => {
    if (node.kind === 'text') return escape(node.value);
    if (node.kind === 'arg') {
      names.push(node.name);
      return '([\\s\\S]*?)';
    }
    return `(?:${toPattern(node.first, names)}|${toPattern(node.second, names)})`;
  }).join('');
}

function compile(template: string): CompiledTemplate | null {
  if (compiled.has(template)) return compiled.get(template) ?? null;
  const nodes = parse(template);
  let result: CompiledTemplate | null = null;
  if (nodes !== null) {
    const names: string[] = [];
    const source = toPattern(nodes, names);
    result = { pattern: new RegExp(`^${source}\\s*$`), names };
  }
  compiled.set(template, result);
  return result;
}

/**
 * Recover the named arguments of a formatted Perforce message.
 *
 * @param template The message's `fmt0` template.
 * @param text The formatted message (`data`), with or without its trailing newline.
 * @returns Argument values by name, or `null` when the text does not follow the template.
 */
export function matchTemplate(template: string, text: string): Readonly<Record<string, string>> | null {
  const compiledTemplate = compile(template);
  if (compiledTemplate === null) return null;
  const match = compiledTemplate.pattern.exec(text.replace(/\s+$/, ''));
  if (match === null) return null;
  const args: Record<string, string> = {};
  compiledTemplate.names.forEach((name, position) => {
    const value = match[position + 1];
    if (value !== undefined && args[name] === undefined) args[name] = value;
  });
  return args;
}
