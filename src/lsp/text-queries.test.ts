// Purpose: completion and signature help tests — scopes at the cursor, receivers after a dot, the uncalled-function fallback, call scanning over broken text, and crash-freedom at every cursor of a truncated document.

import {describe, expect, test} from 'vitest';
import {
  CompletionItemKind,
  type CompletionItem,
  type SignatureHelp,
} from 'vscode-languageserver';
import {CATALOG, formatNativeSignature, nativeFuncs} from '../checker/catalog';
import {KEYWORDS} from '../syntax/tokens';
import {analyze} from './analysis';
import {completion, signatureHelp} from './text-queries';

// `|` marks the cursor and is removed from the analyzed text.
function at(marked: string) {
  const offset = marked.indexOf('|');
  expect(offset).toBeGreaterThanOrEqual(0);
  const text = marked.slice(0, offset) + marked.slice(offset + 1);
  const before = text.slice(0, offset).split('\n');
  return {
    analysis: analyze({filename: 'test.tea', source: text}),
    text,
    position: {line: before.length - 1, character: before.at(-1)!.length},
  };
}

function complete(marked: string): CompletionItem[] {
  const {analysis, text, position} = at(marked);
  return completion(analysis, text, position);
}

function labels(marked: string): string[] {
  return complete(marked).map(item => item.label);
}

function item(marked: string, label: string): CompletionItem | undefined {
  return complete(marked).find(candidate => candidate.label === label);
}

function help(marked: string): SignatureHelp | null {
  const {analysis, text, position} = at(marked);
  return signatureHelp(analysis, text, position);
}

const catalogUnder = (prefix: string) =>
  [...CATALOG.funcs.keys(), ...CATALOG.vars.keys()]
    .filter(name => name.startsWith(prefix))
    .map(name => name.slice(prefix.length));

describe('completion: scopes', () => {
  const NESTED = [
    'a = 1',
    'if close > open',
    '    b = 2',
    '    if b > 1',
    '        c = 3',
    '        INNER',
    '    else',
    '        d = 4',
    '    OUTER',
    'else',
    '    e = 5',
    'AFTER',
    'z = 6',
  ].join('\n');
  // The other marks leave blank lines behind.
  const cursorAt = (mark: string) =>
    NESTED.replace(/INNER|OUTER|AFTER/g, found => (found === mark ? '|' : ''));

  test('a nested block sees enclosing locals and omits sibling blocks', () => {
    const inner = labels(cursorAt('INNER'));
    expect(inner).toEqual(expect.arrayContaining(['a', 'b', 'c', 'z']));
    expect(inner).not.toContain('d');
    expect(inner).not.toContain('e');
  });

  test('on a blank line the column selects the block or its parent', () => {
    // At the outer block's indentation, after the inner `if` closed.
    const outer = labels(cursorAt('OUTER'));
    expect(outer).toEqual(expect.arrayContaining(['a', 'b']));
    expect(outer).not.toContain('c');
    expect(outer).not.toContain('d');
    // At column 0, after the whole `if`.
    const after = labels(cursorAt('AFTER'));
    expect(after).toEqual(expect.arrayContaining(['a', 'z']));
    expect(after).not.toContain('b');
    expect(after).not.toContain('e');
    // The same blank line, indented: the `else` block it would continue.
    expect(labels(cursorAt('AFTER').replace('|', '    |'))).toContain('e');
  });

  test('a blank indented line at the end of the text is inside its block', () => {
    expect(labels('if close > open\n    y = 1\n    |')).toContain('y');
    expect(labels('if close > open\n    y = 1\n|')).not.toContain('y');
  });

  test('a line being typed belongs to its block, at any end of the text', () => {
    expect(labels('if close > open\n    y = 1\n    w = y + |')).toContain('y');
    expect(labels('if close > open\n    y = 1\n    w|\nz = 2\n')).toContain(
      'y',
    );
    expect(labels('if close > open\n    y = 1\nw|\nz = 2\n')).not.toContain(
      'y',
    );
  });

  // A nested block ends at its Dedent, which sits on the first line AFTER it.
  // That line is outside every block the Dedent closes.
  test('the line after a block that ends in a nested block is outside both', () => {
    const afterFunction = labels(
      [
        'f(a) =>',
        '    total = 0.0',
        '    for i = 0 to 3',
        '        total := total + a',
        'x = |',
        'y = f(close)',
      ].join('\n'),
    );
    expect(afterFunction).not.toContain('total');
    expect(afterFunction).not.toContain('a');
    expect(afterFunction).not.toContain('i');
    expect(afterFunction).toContain('f');

    const afterIf = labels(
      [
        'if close > open',
        '    s = 1',
        '    if s > 0',
        '        t = 2',
        'u = |',
      ].join('\n'),
    );
    expect(afterIf).not.toContain('s');
    expect(afterIf).not.toContain('t');
  });

  test('a loop offers its index, a function body its parameters', () => {
    expect(labels('for i = 0 to 3\n    s = i\n    |\n')).toEqual(
      expect.arrayContaining(['s', 'i']),
    );
    const marked = 'f(a, b) =>\n    c = a + b\n    |\nz = f(close, 1)\n';
    expect(labels(marked)).toEqual(expect.arrayContaining(['c', 'a', 'b']));
    expect(item(marked, 'a')).toMatchObject({
      kind: CompletionItemKind.Variable,
      detail: 'series float a',
    });
    // An expression body has only the function's own scope.
    expect(labels('g(x) => x + |\ny = g(1)\n')).toContain('x');
    expect(labels('g(x) => x + 1\ny = g(1) + |\n')).not.toContain('x');
  });

  test('a body called with two signatures offers each local once', () => {
    const found = labels(
      'f(a) =>\n    c = a + 1\n    |\nz = f(close)\nw = f(1)\n',
    );
    expect(found.filter(label => label === 'c')).toEqual(['c']);
    expect(found.filter(label => label === 'a')).toEqual(['a']);
  });

  test('nearer scopes come first, then the catalog roots, then keywords', () => {
    const items = complete('f(a) =>\n    c = a + 1\n    |\nz = f(close)\n');
    const rank = (label: string) =>
      items.find(candidate => candidate.label === label)?.sortText ?? '';
    const order = ['c', 'a', 'z', 'ta', 'close', 'if'].map(rank);
    expect(order.every(text => text !== '')).toBe(true);
    expect([...order].sort()).toEqual(order);
    expect(new Set(order).size).toBe(order.length);
    expect(items.map(candidate => candidate.sortText)).toEqual(
      items.map(candidate => candidate.sortText).sort(),
    );

    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'close',
          kind: CompletionItemKind.Variable,
          detail: 'series float close',
        }),
        expect.objectContaining({
          label: 'nz',
          kind: CompletionItemKind.Function,
          detail: formatNativeSignature(nativeFuncs('nz')![0]),
        }),
        expect.objectContaining({
          label: 'math',
          kind: CompletionItemKind.Module,
        }),
        expect.objectContaining({
          label: 'ta',
          kind: CompletionItemKind.Module,
          detail: 'library ta',
        }),
        expect.objectContaining({
          label: 'f',
          kind: CompletionItemKind.Function,
          detail: 'f(a)',
        }),
      ]),
    );
    for (const keyword of KEYWORDS) {
      expect(rank(keyword)).not.toBe('');
    }
    // A label is offered once: `plot` is a prelude function and a namespace.
    const all = items.map(candidate => candidate.label);
    expect(new Set(all).size).toBe(all.length);
    expect(items.find(c => c.label === 'plot')?.kind).toBe(
      CompletionItemKind.Function,
    );
  });

  test('an uncalled function offers its parameters, the package and the catalog', () => {
    const marked = 'top = 1\nf(a, simple int b) =>\n    c = a + b\n    |\n';
    const found = labels(marked);
    expect(found).toEqual(
      expect.arrayContaining(['a', 'b', 'f', 'top', 'ta', 'close', 'math']),
    );
    // No call, so the checker never entered the body: no local.
    expect(found).not.toContain('c');
    expect(item(marked, 'b')).toMatchObject({
      kind: CompletionItemKind.Variable,
      detail: 'simple int b',
      sortText: '00',
    });
    // The same fallback after a dot whose receiver has no fact.
    expect(labels('f(a) =>\n    c = a\n    c.|\n')).toEqual(
      expect.arrayContaining(['a', 'f', 'close']),
    );
  });
});

describe('completion: after a dot', () => {
  const STRUCT = [
    'struct Bar',
    '    float top = 0.0',
    '    float scaled(float k) const =>',
    '        this.top * k',
    'bar = Bar.new(high)',
  ].join('\n');

  test('`ta.` lists the exports of ta, with or without a typed prefix', () => {
    const {analysis} = at('|');
    const ta = [...analysis.checked.packageContexts.keys()].find(
      pkg => pkg.name === 'ta',
    );
    const exported = [...ta!.exports.keys()];
    expect(exported).toEqual(expect.arrayContaining(['ema', 'sma', 'rsi']));
    expect(labels('x = ta.|')).toEqual(exported);
    expect(labels('x = ta.e|\ny = 1\n')).toEqual(exported);
    expect(labels('x = ta.em|a(close, 9)\n')).toEqual(exported);
    expect(item('x = ta.|', 'ema')).toEqual({
      label: 'ema',
      kind: CompletionItemKind.Function,
      detail: 'ema(source, length)',
      sortText: '00',
    });
  });

  test('an import alias lists the exports of its package', () => {
    expect(labels('import trade as tr\nx = tr.|')).toEqual(
      expect.arrayContaining(['Sizing', 'percentOfEquity']),
    );
  });

  test('a native namespace lists the catalog entries under it', () => {
    expect(labels('x = math.|\n').sort()).toEqual(catalogUnder('math.').sort());
    expect(item('x = math.|', 'max')).toMatchObject({
      kind: CompletionItemKind.Function,
      detail: formatNativeSignature(nativeFuncs('math.max')![0]),
    });
    expect(item('x = color.|', 'red')).toMatchObject({
      kind: CompletionItemKind.Constant,
      detail: 'const color color.red',
    });
    expect(item('x = syminfo.|', 'ticker')).toMatchObject({
      kind: CompletionItemKind.Variable,
      detail: 'simple string syminfo.ticker',
    });
  });

  test('a struct value lists its fields and methods', () => {
    const members = [
      {
        label: 'top',
        kind: CompletionItemKind.Field,
        detail: 'float top',
        sortText: '00',
      },
      {
        label: 'scaled',
        kind: CompletionItemKind.Method,
        detail: 'Bar.scaled(float k)',
        sortText: '00',
      },
    ];
    expect(complete(`${STRUCT}\npeak = bar.|\n`)).toEqual(members);
    // `this` inside a method is a value of the owning struct.
    expect(complete(STRUCT.replace('this.top * k', 'this.|'))).toEqual(members);
    // A struct-typed local of a called function.
    expect(labels(`${STRUCT}\nf(b) =>\n    b.|\nx = f(bar)\n`)).toEqual([
      'top',
      'scaled',
    ]);
  });

  // A generic struct nobody specialized yet is the normal state while
  // writing one, and in a library file.
  test('`this.` works inside a generic struct that has no specialization', () => {
    const GENERIC = [
      'interface Reader',
      '    int read() const',
      'type Holder<T: Reader>',
      '    T source',
      '    int add(int extra) const =>',
      '        extra',
      '    int get() const =>',
      '        this.MARK',
      'plot("c", close)',
    ].join('\n');
    expect(labels(GENERIC.replace('MARK', '|')).sort()).toEqual([
      'add',
      'get',
      'source',
    ]);
    expect(
      help(GENERIC.replace('MARK', 'add(|'))?.signatures[0].label,
    ).toContain('add(');
  });

  test('an enum lists its members', () => {
    expect(complete('enum Dir\n    up\n    down\nd = Dir.|\n')).toEqual([
      {
        label: 'up',
        kind: CompletionItemKind.EnumMember,
        detail: 'Dir.up',
        sortText: '00',
      },
      {
        label: 'down',
        kind: CompletionItemKind.EnumMember,
        detail: 'Dir.down',
        sortText: '00',
      },
    ]);
  });

  test('any other receiver gets the scope list', () => {
    const scopeList = labels('bar = 1\nx = |');
    for (const marked of [
      'bar = 1\nx = foo().|',
      'bar = 1\nx = syminfo.ticker.|',
      'bar = 1\nx = unknown.|',
      'bar = 1\nx = bar.|',
      'bar = 1\nx = 1.|',
    ]) {
      expect(labels(marked)).toEqual(scopeList);
    }
  });

  test('a string and a line comment complete nothing', () => {
    expect(complete('title = "see ta.|"')).toEqual([]);
    expect(complete('title = "see ta.|')).toEqual([]);
    expect(complete('x = 1 // see ta.|')).toEqual([]);
    expect(complete('// |')).toEqual([]);
    // After a string, not inside it; a `//` inside a string is no comment.
    expect(labels('x = "a" + ta.|')).toContain('ema');
    expect(labels('x = "http://a" + ta.|')).toContain('ema');
  });
});

describe('signature help', () => {
  const USER = 'g(x, simple int n) => x\nf(a, b) => a\n';

  test('a native shows every overload', () => {
    const overloads = nativeFuncs('math.max')!;
    expect(help('x = math.max(|')).toEqual({
      signatures: overloads.map(overload => ({
        label: formatNativeSignature(overload),
        parameters: overload.params.map(param => ({
          label: expect.stringContaining(`${param.name}: `),
        })),
        activeParameter: 0,
      })),
      activeSignature: 0,
      activeParameter: 0,
    });
    expect(help('x = nz(close, |')?.signatures.map(s => s.label)).toEqual(
      nativeFuncs('nz')!.map(formatNativeSignature),
    );
  });

  test('a variadic parameter stays active past its position', () => {
    expect(help('x = math.max(1, 2, 3, |')).toMatchObject({
      activeSignature: 0,
      activeParameter: 1,
    });
  });

  test('the active signature is the first with enough parameters', () => {
    const found = help('a = array.new<float>(|');
    expect(found?.signatures.map(s => s.label)).toEqual(
      nativeFuncs('array.new')!.map(formatNativeSignature),
    );
    // `array.new()` takes nothing, so the overload with a `size` is active.
    expect(found).toMatchObject({activeSignature: 1, activeParameter: 0});
    expect(found?.signatures[1].parameters?.[0].label).toBe('size: int');
    // No overload takes a second argument: the first signature stands.
    expect(help('x = str.tostring(1, |')).toMatchObject({
      activeSignature: 0,
      activeParameter: 1,
    });
  });

  test('a user function shows its written signature', () => {
    expect(help(`${USER}y = g(|`)).toEqual({
      signatures: [
        {
          label: 'g(x, simple int n)',
          parameters: [{label: 'x'}, {label: 'simple int n'}],
          activeParameter: 0,
        },
      ],
      activeSignature: 0,
      activeParameter: 0,
    });
  });

  test('the second argument is parameter 1', () => {
    expect(help(`${USER}y = g(close, |`)?.activeParameter).toBe(1);
    expect(help(`${USER}y = g(close, 1|`)?.activeParameter).toBe(1);
    expect(help(`${USER}y = g(close|, 1)`)?.activeParameter).toBe(0);
    expect(help(`${USER}y = g(f(1, 2), |`)?.activeParameter).toBe(1);
    expect(help(`${USER}y = g([1, 2], |`)?.activeParameter).toBe(1);
    expect(help(`${USER}y = g(close, [1, 2, |`)?.activeParameter).toBe(1);
  });

  test('a nested call answers for the innermost open one', () => {
    const inner = help(`${USER}y = f(g(close, |`);
    expect(inner?.signatures[0].label).toBe('g(x, simple int n)');
    expect(inner?.activeParameter).toBe(1);
    const outer = help(`${USER}y = f(g(close, 1), |`);
    expect(outer?.signatures[0].label).toBe('f(a, b)');
    expect(outer?.activeParameter).toBe(1);
  });

  test('a string holding commas and parens counts as one argument', () => {
    for (const marked of [
      `${USER}y = g("a, (b|`,
      `${USER}y = g("a, (b|", 1)`,
      `${USER}y = g('a, )b|`,
    ]) {
      const found = help(marked);
      expect(found?.signatures[0].label).toBe('g(x, simple int n)');
      expect(found?.activeParameter).toBe(0);
    }
    expect(help(`${USER}y = g("a, (b", |`)?.activeParameter).toBe(1);
  });

  test('a call spanning lines is one call', () => {
    const found = help(`${USER}y = g(\n    close,\n    |`);
    expect(found?.signatures[0].label).toBe('g(x, simple int n)');
    expect(found?.activeParameter).toBe(1);
  });

  test('a named argument activates the parameter it spells', () => {
    expect(help(`${USER}y = g(n = |`)?.activeParameter).toBe(1);
    expect(help('plot("p", close, color = |')).toMatchObject({
      activeSignature: 0,
      activeParameter: 3,
    });
    expect(help('x = nz(replacement = |')?.activeParameter).toBe(1);
    // A comparison is no name.
    expect(help(`${USER}y = g(x == |`)?.activeParameter).toBe(0);
  });

  test('a library function and a struct method resolve through their receiver', () => {
    expect(help('x = ta.ema(close, |')).toMatchObject({
      signatures: [
        {
          label: 'ema(source, length)',
          parameters: [{label: 'source'}, {label: 'length'}],
        },
      ],
      activeParameter: 1,
    });
    const struct =
      'struct Bar\n    float top = 0.0\n    float scaled(float k) const =>\n        this.top * k\nbar = Bar.new(high)\n';
    expect(help(`${struct}half = bar.scaled(|`)?.signatures).toEqual([
      {
        label: 'Bar.scaled(float k)',
        parameters: [{label: 'float k'}],
        activeParameter: 0,
      },
    ]);
  });

  test('outside a call there is none', () => {
    for (const marked of [
      '|',
      'x = 1 + |',
      `${USER}y = g(close, 1)|`,
      `${USER}y = g(close, 1)\nz = |`,
      'x = (1 + |',
      'x = [1, |',
      'x = unknown(|',
      'x = close(|',
      'x = a.b.c(|',
      'x = "g(|',
    ]) {
      expect(help(marked)).toBeNull();
    }
  });

  test('every native parameter label is found in its signature label', () => {
    // A client highlights a parameter by finding its label in the signature.
    for (const name of CATALOG.funcs.keys()) {
      const found = help(`x = ${name}(|`);
      expect(found?.signatures.length).toBe(nativeFuncs(name)!.length);
      for (const signature of found!.signatures) {
        for (const parameter of signature.parameters!) {
          expect(signature.label).toContain(parameter.label);
        }
      }
    }
  });
});

describe('robustness', () => {
  const SOURCE = [
    '//@version=6',
    'enum Dir',
    '    up',
    '    down',
    'struct Bar',
    '    float top = 0.0',
    '    float scaled(float k) const =>',
    '        this.top * k',
    'g(x) =>',
    '    y = x + 1',
    '    if y > 2',
    '        y := y * 2',
    '    y',
    'unused(z, simple int n) => z',
    'bar = Bar.new(high)',
    'a = g(close)',
    'b = g(1)',
    'half = bar.scaled(0.5) // half "of" it',
    'best = math.max(a, ta.ema(close, 14))',
    'sizes = array.new<float>(0)',
    'for i = 0 to 3',
    '    array.push(sizes, a + i)',
    'if a > b',
    '    plot("line, (", a, color = color.red)',
    '',
  ].join('\n');

  // Broken trailing text is the normal input: the document cut at every
  // offset, asked at the cut, which is where the caret is while typing.
  test('neither query throws on any truncation of a document', () => {
    for (let cut = 0; cut <= SOURCE.length; cut += 1) {
      const text = SOURCE.slice(0, cut);
      const lines = text.split('\n');
      const position = {
        line: lines.length - 1,
        character: lines.at(-1)!.length,
      };
      const analysis = analyze({filename: 'test.tea', source: text});
      for (const found of completion(analysis, text, position)) {
        expect(found.label).not.toBe('');
      }
      signatureHelp(analysis, text, position);
    }
  });

  test('neither query throws at any position, in or past the document', () => {
    const analysis = analyze({filename: 'test.tea', source: SOURCE});
    expect(analysis.diagnostics).toEqual([]);
    const lines = SOURCE.split('\n');
    for (let line = 0; line <= lines.length + 1; line += 1) {
      const length = lines[line]?.length ?? 0;
      for (let character = 0; character <= length + 2; character += 1) {
        completion(analysis, SOURCE, {line, character});
        signatureHelp(analysis, SOURCE, {line, character});
      }
    }
  });
});
