import { common, createLowlight } from 'lowlight';

type SyntaxNode = { type: string; value?: string; properties?: { className?: unknown }; children?: SyntaxNode[] };
export type SyntaxToken = { value: string; classes: string[] };
export type HighlightedCode = { language: string | null; lines: SyntaxToken[][] };

const highlighter = createLowlight(common);
const extensions: Record<string, string> = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    py: 'python', pyw: 'python', rs: 'rust', go: 'go', rb: 'ruby', rake: 'ruby',
    java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift', cs: 'csharp',
    c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hh: 'cpp', hpp: 'cpp', ino: 'arduino',
    m: 'objectivec', mm: 'objectivec', php: 'php', phtml: 'php', pl: 'perl', pm: 'perl',
    lua: 'lua', r: 'r', sql: 'sql', graphql: 'graphql', gql: 'graphql', vb: 'vbnet', wat: 'wasm',
    html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml',
    css: 'css', scss: 'scss', less: 'less', json: 'json', jsonc: 'json',
    yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
    sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'shell',
    md: 'markdown', markdown: 'markdown', mdx: 'markdown', mk: 'makefile',
    patch: 'diff', diff: 'diff',
};
const filenames: Record<string, string> = {
    makefile: 'makefile', gnumakefile: 'makefile', gemfile: 'ruby', rakefile: 'ruby',
    '.bashrc': 'bash', '.bash_profile': 'bash', '.zshrc': 'bash', '.profile': 'bash',
    '.gitconfig': 'ini', '.editorconfig': 'ini', '.npmrc': 'ini', '.yarnrc': 'ini',
};

/** Choose a grammar from the filename, with shebang detection for extensionless scripts. */
export function languageForFile(path: string, source = ''): string | null {
    const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? '';
    const extension = name.includes('.') ? name.split('.').pop() ?? '' : '';
    const known = filenames[name] ?? extensions[extension];
    if (known) return known;
    // Explicit text/unknown extensions stay plain; do not guess from their contents.
    if (extension) return null;
    const interpreter = source.match(/^#!\s*(?:\/\S*\/)?(?:env\s+(?:-S\s+)?)?([\w.-]+)/)?.[1];
    if (/^python(?:\d(?:\.\d+)*)?$/.test(interpreter ?? '')) return 'python';
    if (/^(?:ba|z|k)?sh$/.test(interpreter ?? '')) return 'bash';
    return ({ node: 'javascript', nodejs: 'javascript', ruby: 'ruby', perl: 'perl' } as Record<string, string>)[interpreter ?? ''] ?? null;
}

function plainLines(source: string): SyntaxToken[][] {
    return source.split('\n').map(value => value ? [{ value, classes: [] }] : []);
}

/** Highlight once per complete file so multiline comments and strings survive diff slicing. */
export function highlightCode(path: string, source: string): HighlightedCode {
    const language = languageForFile(path, source);
    // Bound grammar work for imported/minified files. Rendering always preserves every byte.
    if (!language || source.length > 100_000 || source.split('\n').some(line => line.length > 10_000)) return { language, lines: plainLines(source) };
    const lines: SyntaxToken[][] = [[]];
    function visit(node: SyntaxNode, inherited: string[]) {
        if (node.type === 'text') {
            const parts = (node.value ?? '').split('\n');
            parts.forEach((value, index) => {
                if (index) lines.push([]);
                if (value) lines[lines.length - 1].push({ value, classes: inherited });
            });
            return;
        }
        const own = node.properties?.className;
        const classes = Array.isArray(own) ? [...inherited, ...own.filter((value): value is string => typeof value === 'string')] : inherited;
        node.children?.forEach(child => visit(child, classes));
    }
    try {
        visit(highlighter.highlight(language, source), []);
        return { language, lines };
    } catch {
        return { language, lines: plainLines(source) };
    }
}
