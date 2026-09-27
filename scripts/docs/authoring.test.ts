// Purpose: Compile the published authoring examples and lock complete generated API inventories.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {expect, test} from 'vitest';
import {CATALOG} from '../../src/checker/catalog';
import {buildText} from '../../src/noder/testing';
import {generate} from '../../src/codegen/codegen';
import {libraryReferences, nativeReference} from './reference-catalog';

const pages = [
  'introduction.md',
  'getting-started/Hello world.md',
  'getting-started/Write your first indicator.md',
  'language-guide/values-and-control-flow.md',
  'language-guide/time-series.md',
  'language-guide/outputs-and-events.md',
  'requests.md',
];
for (const page of pages) {
  test(`authoring examples compile: ${page}`, () => {
    const markdown = readFileSync(
      fileURLToPath(new URL(`../../docs/${page}`, import.meta.url)),
      'utf8',
    );
    const examples = [...markdown.matchAll(/```tea\n([\s\S]*?)```/g)];
    expect(examples.length).toBeGreaterThan(0);
    for (const [index, example] of examples.entries()) {
      const result = buildText(example[1]!, `${page}-${index}.tea`);
      expect(result.errors.map(error => error.msg)).toEqual([]);
      expect(result.program).not.toBeNull();
      expect(generate(result.program!).length).toBeGreaterThan(0);
    }
  });
}

test('generated references cover all native functions and shipped library declarations', () => {
  const native = nativeReference();
  for (const name of CATALOG.funcs.keys())
    expect(native).toContain(`## ${name}\n`);
  expect(native).toContain('→ request-dependent result');
  const libraries = libraryReferences();
  expect([...libraries.keys()]).toEqual([
    'broker',
    'geometry',
    'pine',
    'portfolio',
    'ta',
    'trade',
    'visual',
  ]);
  expect(libraries.get('ta')).toContain('source, length = 1');
  expect(libraries.get('visual')).toContain('const string id');
  expect(libraries.get('visual')).toContain('series string message');
  expect(libraries.get('ta')).not.toContain('sum / length');
  expect(libraries.get('pine')).toContain('## pine.close\n');
  expect(libraries.get('pine')).toContain(
    'export close = input.series("close")',
  );
});
