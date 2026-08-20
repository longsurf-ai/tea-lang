// Purpose: Verify the Codex documentation workflow's scope, inventory, task ordering, safety boundaries, and resumable event parsing without invoking Codex.

import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';

import {
  buildPrompt,
  buildTaskList,
  collectInventory,
  gateBeforeTask,
  incompletePredecessors,
  parseCli,
  parseThreadId,
  pathAllowed,
  validateScope,
  type DesiredFeature,
  type ReferenceScope,
} from './workflow';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../..');
const SCOPE_FILE = path.join(TEST_DIR, 'scope.json');

async function scope(): Promise<ReferenceScope> {
  return validateScope(
    JSON.parse(await readFile(SCOPE_FILE, 'utf8')) as unknown,
  );
}

describe('reference documentation Codex workflow', () => {
  test('loads one exhaustive serial plan with a mandatory pilot review gate', async () => {
    const current = await scope();
    const tasks = buildTaskList(current);

    expect(current.currentScope.categories).toEqual([
      'types',
      'variables',
      'constants',
      'functions',
      'keywords',
      'operators',
      'annotations',
    ]);
    expect(tasks[0]?.id).toBe('foundation');
    expect(tasks[1]?.id).toBe('pilot');
    expect(tasks.at(-1)?.id).toBe('final-verification');
    expect(new Set(tasks.map(task => task.id)).size).toBe(tasks.length);
    expect(current.approvalGates).toEqual([
      expect.objectContaining({id: 'pilot-review', after: 'pilot'}),
    ]);
    expect(current.excludedSymbols).toContain('broker.*');
    expect(current.excludedSymbols).toContain('portfolio.*');
    expect(current.excludedSymbols).toContain('trade.*');
  });

  test('places fully specified desired features before documentation work', async () => {
    const current = await scope();
    const desired: DesiredFeature = {
      id: 'sample-feature',
      kind: 'language',
      specification:
        'Sample source-observable semantics detailed enough for an implementation task.',
      acceptance: ['A valid result', 'A stable invalid-source diagnostic'],
      allowedPaths: ['src/', 'tests/'],
      validate: ['npm run typecheck'],
    };
    const tasks = buildTaskList({...current, desiredFeatures: [desired]});

    expect(tasks[0]).toEqual(
      expect.objectContaining({
        id: 'feature-sample-feature',
        kind: 'desired-feature',
      }),
    );
    expect(tasks[0]?.objective).toContain(desired.specification);
    expect(tasks[1]?.id).toBe('foundation');
  });

  test('cannot bypass the pilot review gate with --only or --from', async () => {
    const current = await scope();
    const tasks = buildTaskList(current);
    const state = {
      approvedGates: [],
    } as unknown as Parameters<typeof gateBeforeTask>[1];

    expect(gateBeforeTask(current, state, tasks, 'types')?.id).toBe(
      'pilot-review',
    );
    state.approvedGates.push('pilot-review');
    expect(gateBeforeTask(current, state, tasks, 'types')).toBeUndefined();
  });

  test('cannot skip unfinished serial predecessors', async () => {
    const current = await scope();
    const tasks = buildTaskList(current);
    const state = {
      tasks: tasks.map(task => ({id: task.id, status: 'pending'})),
    } as unknown as Parameters<typeof incompletePredecessors>[1];

    expect(incompletePredecessors(tasks, state, 'pilot')).toEqual([
      'foundation',
    ]);
    state.tasks[0]!.status = 'completed';
    expect(incompletePredecessors(tasks, state, 'pilot')).toEqual([]);
  });

  test('derives the current inventory from compiler-owned catalogs', async () => {
    const inventory = await collectInventory(ROOT, '1');

    expect(inventory.types).toContain('array');
    expect(inventory.variables).toContain('close');
    expect(inventory.constants).toContain('color.red');
    expect(
      inventory.nativeFunctions.some(item => item.name === 'array.push'),
    ).toBe(true);
    expect(
      inventory.nativeFunctions.find(item => item.name === 'request.security')
        ?.stagedParameters,
    ).toContain('currency');
    expect(inventory.taExports).toContain('ema');
    expect(inventory.taExports.some(name => name.startsWith('broker'))).toBe(
      false,
    );
    expect(inventory.keywords).toContain('struct');
    expect(inventory.operators).toContain('[] history');
  });

  test('builds a bounded prompt that forbids nesting Codex agents and commits', async () => {
    const current = await scope();
    const task = buildTaskList(current)[0]!;
    const prompt = buildPrompt({
      scope: current,
      task,
      inventoryFile: '/tmp/inventory.json',
      scopeFile: '/tmp/scope.json',
      priorSummaries: ['pilot: reviewed'],
    });

    expect(prompt).toContain('Do not spawn subagents');
    expect(prompt).toContain('do not stop at a plan');
    expect(prompt).toContain('Do not touch a path outside this list');
    expect(prompt).toContain('Do not document broker, portfolio, or trade');
    expect(prompt).toContain('pilot: reviewed');
  });

  test('extracts thread ids and enforces allowed path prefixes', () => {
    expect(
      parseThreadId(
        [
          JSON.stringify({type: 'turn.started'}),
          JSON.stringify({type: 'thread.started', thread_id: 'thread-123'}),
        ].join('\n'),
      ),
    ).toBe('thread-123');
    expect(
      pathAllowed('docs/reference/types/array.md', ['docs/reference/']),
    ).toBe(true);
    expect(pathAllowed('docs/docs.json', ['docs/docs.json'])).toBe(true);
    expect(pathAllowed('package.json', ['docs/reference/'])).toBe(false);
  });

  test('parses plan controls without starting a run', () => {
    const options = parseCli([
      'plan',
      '--only',
      'foundation,pilot',
      '--from',
      'foundation',
      '--max-retries',
      '3',
    ]);

    expect(options.command).toBe('plan');
    expect(options.only).toEqual(new Set(['foundation', 'pilot']));
    expect(options.from).toBe('foundation');
    expect(options.maxRetries).toBe(3);
  });
});
