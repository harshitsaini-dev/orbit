/**
 * Syntax highlighting for previewing a file, not for editing one.
 *
 * Deliberately a tokeniser rather than a parser, and deliberately not an editor.
 * Monaco is around five megabytes of code editor to display text nobody can
 * type into, and every highlighter small enough to be worth shipping - Prism
 * included - is regex-based anyway. So this is that, at a size proportionate to
 * the job, with no dependency and no `innerHTML`: it returns tokens and the
 * component renders them as elements, so a file's contents can never become
 * markup.
 *
 * What it will get wrong: a regex literal that looks like division, a nested
 * template string, a keyword used as an identifier. Those cost a word the wrong
 * colour in a read-only preview, which is the right trade at this size.
 */

export type TokenType =
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'literal'
  | 'tag'
  | 'attribute'
  | 'punctuation'
  | 'plain';

export interface Token {
  text: string;
  type: TokenType;
}

/** Beyond this, highlighting costs more than it is worth and plain text wins. */
export const HIGHLIGHT_LIMIT = 400 * 1024;

interface Rule {
  type: TokenType;
  pattern: RegExp;
}

const C_KEYWORDS =
  'as|async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|finally|for|from|function|get|if|implements|import|in|instanceof|interface|let|new|of|package|private|protected|public|readonly|return|set|static|super|switch|this|throw|try|type|typeof|var|void|while|with|yield';

const PY_KEYWORDS =
  'and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield';

const SHELL_KEYWORDS =
  'if|then|else|elif|fi|for|while|do|done|case|esac|function|return|export|local|readonly|source|alias|echo|cd|exit';

const SQL_KEYWORDS =
  'select|from|where|insert|into|values|update|set|delete|create|table|alter|drop|index|join|inner|left|right|outer|on|group|by|order|having|limit|offset|union|all|as|and|or|not|null|distinct|primary|key|foreign|references|default|unique|constraint|case|when|then|end';

/**
 * Rule order is the whole design: comments and strings come first, so a keyword
 * inside a comment stays a comment rather than being coloured as code.
 */
const LANGUAGES: Record<string, Rule[]> = {
  clike: [
    { type: 'comment', pattern: /\/\*[\s\S]*?\*\/|\/\/[^\n]*/y },
    { type: 'string', pattern: /`(?:\\[\s\S]|[^\\`])*`|"(?:\\[\s\S]|[^\\"\n])*"|'(?:\\[\s\S]|[^\\'\n])*'/y },
    { type: 'number', pattern: /\b0[xX][\da-fA-F_]+n?\b|\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?n?\b/y },
    { type: 'literal', pattern: /\b(?:true|false|null|undefined|NaN|Infinity)\b/y },
    { type: 'keyword', pattern: new RegExp(`\\b(?:${C_KEYWORDS})\\b`, 'y') },
    { type: 'punctuation', pattern: /[{}[\]();,.:?=+\-*/%<>!&|^~]+/y },
  ],
  python: [
    { type: 'comment', pattern: /#[^\n]*/y },
    { type: 'string', pattern: /'''[\s\S]*?'''|"""[\s\S]*?"""|[rRbBfFuU]{0,2}(?:"(?:\\[\s\S]|[^\\"\n])*"|'(?:\\[\s\S]|[^\\'\n])*')/y },
    { type: 'number', pattern: /\b0[xXbBoO][\da-fA-F_]+\b|\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?\b/y },
    { type: 'literal', pattern: /\b(?:True|False|None|self|cls)\b/y },
    { type: 'keyword', pattern: new RegExp(`\\b(?:${PY_KEYWORDS})\\b`, 'y') },
    { type: 'punctuation', pattern: /[{}[\]();,.:?=+\-*/%<>!&|^~@]+/y },
  ],
  shell: [
    { type: 'comment', pattern: /#[^\n]*/y },
    { type: 'string', pattern: /"(?:\\[\s\S]|[^\\"])*"|'[^']*'/y },
    { type: 'number', pattern: /\b\d+\b/y },
    { type: 'literal', pattern: /\$\{[^}]*\}|\$\w+/y },
    { type: 'keyword', pattern: new RegExp(`\\b(?:${SHELL_KEYWORDS})\\b`, 'y') },
    { type: 'punctuation', pattern: /[{}[\]();,.:?=+\-*/%<>!&|^~]+/y },
  ],
  sql: [
    { type: 'comment', pattern: /--[^\n]*|\/\*[\s\S]*?\*\//y },
    { type: 'string', pattern: /'(?:''|[^'])*'|"(?:""|[^"])*"/y },
    { type: 'number', pattern: /\b\d+(?:\.\d+)?\b/y },
    { type: 'keyword', pattern: new RegExp(`\\b(?:${SQL_KEYWORDS})\\b`, 'iy') },
    { type: 'punctuation', pattern: /[(),.;*=<>+\-/|]+/y },
  ],
  markup: [
    { type: 'comment', pattern: /<!--[\s\S]*?-->/y },
    // The tag name and its punctuation, taken together so a bare < in text is
    // not mistaken for the start of an element.
    { type: 'tag', pattern: /<\/?[a-zA-Z][\w:-]*|\/?>/y },
    { type: 'string', pattern: /"(?:[^"]*)"|'(?:[^']*)'/y },
    { type: 'attribute', pattern: /\b[a-zA-Z_:][\w:.-]*(?=\s*=)/y },
  ],
  css: [
    { type: 'comment', pattern: /\/\*[\s\S]*?\*\//y },
    { type: 'string', pattern: /"(?:\\[\s\S]|[^\\"\n])*"|'(?:\\[\s\S]|[^\\'\n])*'/y },
    { type: 'literal', pattern: /--[\w-]+|@[\w-]+/y },
    { type: 'number', pattern: /#[\da-fA-F]{3,8}\b|\b-?\d*\.?\d+(?:px|em|rem|%|vh|vw|s|ms|deg|fr|ch)?\b/y },
    { type: 'attribute', pattern: /[\w-]+(?=\s*:)/y },
    { type: 'punctuation', pattern: /[{}();,:>+~*]+/y },
  ],
  json: [
    { type: 'attribute', pattern: /"(?:\\[\s\S]|[^\\"])*"(?=\s*:)/y },
    { type: 'string', pattern: /"(?:\\[\s\S]|[^\\"])*"/y },
    { type: 'number', pattern: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y },
    { type: 'literal', pattern: /\b(?:true|false|null)\b/y },
    { type: 'punctuation', pattern: /[{}[\],:]+/y },
  ],
  yaml: [
    { type: 'comment', pattern: /#[^\n]*/y },
    { type: 'attribute', pattern: /^[ \t]*-?[ \t]*[\w.-]+(?=\s*:)/my },
    { type: 'string', pattern: /"(?:\\[\s\S]|[^\\"])*"|'[^']*'/y },
    { type: 'number', pattern: /\b-?\d+(?:\.\d+)?\b/y },
    { type: 'literal', pattern: /\b(?:true|false|null|yes|no|on|off)\b/y },
    { type: 'punctuation', pattern: /[:[\]{},|>-]+/y },
  ],
  markdown: [
    { type: 'comment', pattern: /^>[^\n]*/my },
    { type: 'keyword', pattern: /^#{1,6}[^\n]*/my },
    { type: 'string', pattern: /```[\s\S]*?```|`[^`\n]+`/y },
    { type: 'tag', pattern: /\[[^\]\n]*\]\([^)\n]*\)/y },
    { type: 'literal', pattern: /\*\*[^*\n]+\*\*|__[^_\n]+__|^\s*[-*+]\s/my },
  ],
};

/** Which rule set a file name maps onto. */
const BY_EXTENSION: Record<string, keyof typeof LANGUAGES> = {
  js: 'clike', mjs: 'clike', cjs: 'clike', jsx: 'clike', ts: 'clike', tsx: 'clike',
  java: 'clike', kt: 'clike', c: 'clike', h: 'clike', cpp: 'clike', hpp: 'clike',
  cs: 'clike', go: 'clike', rs: 'clike', swift: 'clike', php: 'clike', dart: 'clike',
  scala: 'clike',
  py: 'python', rb: 'python',
  sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'shell', bat: 'shell', env: 'shell',
  sql: 'sql',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup', svelte: 'markup',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  json: 'json', ipynb: 'json',
  yml: 'yaml', yaml: 'yaml', toml: 'yaml', ini: 'yaml',
  md: 'markdown', markdown: 'markdown',
};

/** A human name for the language, shown in the viewer's toolbar. */
const LABELS: Record<string, string> = {
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JSX',
  ts: 'TypeScript', tsx: 'TSX', py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust',
  java: 'Java', kt: 'Kotlin', swift: 'Swift', c: 'C', h: 'C', cpp: 'C++', hpp: 'C++',
  cs: 'C#', php: 'PHP', dart: 'Dart', scala: 'Scala', sh: 'Shell', bash: 'Shell',
  zsh: 'Shell', ps1: 'PowerShell', bat: 'Batch', sql: 'SQL', html: 'HTML', htm: 'HTML',
  xml: 'XML', svg: 'SVG', vue: 'Vue', svelte: 'Svelte', css: 'CSS', scss: 'SCSS',
  sass: 'Sass', less: 'Less', json: 'JSON', ipynb: 'Notebook', yml: 'YAML', yaml: 'YAML',
  toml: 'TOML', ini: 'INI', md: 'Markdown', markdown: 'Markdown', csv: 'CSV', tsv: 'TSV',
  txt: 'Plain text', log: 'Log',
};

export function languageLabel(fileName: string): string {
  const extension = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  return LABELS[extension] ?? 'Plain text';
}

/**
 * Splits source into tokens.
 *
 * Anything with no rule set, or too large to be worth the work, comes back as a
 * single plain token - which the viewer renders identically, just without
 * colour.
 */
export function tokenise(source: string, fileName: string): Token[] {
  const extension = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  const rules = LANGUAGES[BY_EXTENSION[extension] ?? ''];

  if (!rules || source.length > HIGHLIGHT_LIMIT) return [{ text: source, type: 'plain' }];

  const tokens: Token[] = [];
  let plain = '';
  let index = 0;

  const flush = () => {
    if (plain) {
      tokens.push({ text: plain, type: 'plain' });
      plain = '';
    }
  };

  while (index < source.length) {
    let matched = false;

    for (const rule of rules) {
      rule.pattern.lastIndex = index;
      const match = rule.pattern.exec(source);
      // A sticky pattern can only match at lastIndex, so a match here is a match
      // starting exactly where we are - no scanning ahead, no overlap.
      if (match && match[0].length > 0) {
        flush();
        tokens.push({ text: match[0], type: rule.type });
        index += match[0].length;
        matched = true;
        break;
      }
    }

    if (!matched) {
      plain += source[index];
      index += 1;
    }
  }

  flush();
  return tokens;
}
