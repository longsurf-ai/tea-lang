#!/usr/bin/env -S node --import tsx
// Purpose: Run the exhaustive Tea reference rewrite as a serial, resumable sequence of schema-checked Codex CLI turns.

import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {CATALOG} from '../../src/checker/catalog';
import {PUBLIC_TYPE_CATALOG} from '../../src/checker/type-catalog';
import {Qualifier} from '../../src/ir/type';
import {AssignOp} from '../../src/syntax/nodes';
import {KEYWORDS, Op} from '../../src/syntax/tokens';

export type ReferenceCategory =
  | 'types'
  | 'variables'
  | 'constants'
  | 'functions'
  | 'keywords'
  | 'operators'
  | 'annotations';

export interface DesiredFeature {
  readonly id: string;
  readonly kind:
    | 'type'
    | 'variable'
    | 'constant'
    | 'function'
    | 'keyword'
    | 'operator'
    | 'annotation'
    | 'language';
  readonly specification: string;
  readonly acceptance: readonly string[];
  readonly allowedPaths: readonly string[];
  readonly validate: readonly string[];
}

export interface Workstream {
  readonly id: string;
  readonly title: string;
  readonly objective: string;
  readonly validate: readonly string[];
}

export interface ApprovalGate {
  readonly id: string;
  readonly after: string;
  readonly message: string;
}

export interface ReferenceScope {
  readonly version: 1;
  readonly name: string;
  readonly target: {
    readonly languageVersion: string;
    readonly policy: 'current' | 'current-plus-desired';
  };
  readonly currentScope: {
    readonly categories: readonly ReferenceCategory[];
    readonly sourceOfTruth: readonly string[];
  };
  readonly desiredFeatures: readonly DesiredFeature[];
  readonly publicationRules: readonly string[];
  readonly excludedSymbols: readonly string[];
  readonly reviewRequired: readonly string[];
  readonly allowedPaths: readonly string[];
  readonly approvalGates: readonly ApprovalGate[];
  readonly workstreams: readonly Workstream[];
}

export interface Inventory {
  readonly languageVersion: string;
  readonly types: readonly string[];
  readonly variables: readonly string[];
  readonly constants: readonly string[];
  readonly nativeFunctions: readonly {
    readonly name: string;
    readonly overloads: number;
    readonly stagedParameters: readonly string[];
  }[];
  readonly keywords: readonly string[];
  readonly operators: readonly string[];
  readonly annotations: readonly string[];
  readonly taExports: readonly string[];
}

export interface WorkflowTask {
  readonly id: string;
  readonly title: string;
  readonly kind: 'desired-feature' | 'documentation';
  readonly objective: string;
  readonly validate: readonly string[];
  readonly allowedPaths: readonly string[];
}

type TaskStatus = 'pending' | 'running' | 'completed' | 'blocked';
type RunStatus = 'active' | 'waiting-approval' | 'completed' | 'blocked';

export interface TaskState {
  readonly id: string;
  readonly title: string;
  readonly kind: WorkflowTask['kind'];
  status: TaskStatus;
  attempts: number;
  threadId?: string;
  summary?: string;
  blocker?: string;
}

export interface RunState {
  readonly version: 1;
  readonly runId: string;
  readonly root: string;
  readonly initialHead: string;
  readonly initialDirtyPaths: readonly string[];
  readonly scopeHash: string;
  readonly scopeFile: string;
  readonly codexVersion: string;
  readonly model?: string;
  readonly createdAt: string;
  updatedAt: string;
  status: RunStatus;
  approvedGates: string[];
  tasks: TaskState[];
}

export interface WorkflowResult {
  readonly status: 'completed' | 'blocked';
  readonly summary: string;
  readonly changed_files: readonly string[];
  readonly validations: readonly {
    readonly command: string;
    readonly status: 'passed' | 'failed' | 'not_run';
    readonly details: string;
  }[];
  readonly coverage: readonly {
    readonly category: string;
    readonly documented: number;
    readonly total: number;
  }[];
  readonly decisions: readonly string[];
  readonly remaining: readonly string[];
}

interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface ValidationResult {
  readonly ok: boolean;
  readonly log: string;
}

interface CliOptions {
  readonly command: 'plan' | 'run' | 'resume' | 'status' | 'approve';
  readonly positional: readonly string[];
  readonly scopeFile: string;
  readonly model?: string;
  readonly only?: ReadonlySet<string>;
  readonly from?: string;
  readonly maxRetries: number;
  readonly allowDirty: boolean;
  readonly runId?: string;
}

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_FILE);
const DEFAULT_SCOPE = path.join(SCRIPT_DIR, 'scope.json');
const RESULT_SCHEMA = path.join(SCRIPT_DIR, 'result.schema.json');
const RUNS_DIR = '.codex/reference-docs';

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    fail(`scope.${field} must be an array of strings`);
  }
  return value as string[];
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    fail(`${label} contains duplicate ids`);
  }
}

export function validateScope(value: unknown): ReferenceScope {
  if (!isRecord(value) || value['version'] !== 1) {
    fail('reference scope must be an object with version 1');
  }
  const target = value['target'];
  const current = value['currentScope'];
  if (!isRecord(target) || !isRecord(current)) {
    fail('scope.target and scope.currentScope are required objects');
  }
  const policy = target['policy'];
  if (policy !== 'current' && policy !== 'current-plus-desired') {
    fail("scope.target.policy must be 'current' or 'current-plus-desired'");
  }
  const categories = strings(current['categories'], 'currentScope.categories');
  const validCategories = new Set<ReferenceCategory>([
    'types',
    'variables',
    'constants',
    'functions',
    'keywords',
    'operators',
    'annotations',
  ]);
  if (
    categories.some(
      category => !validCategories.has(category as ReferenceCategory),
    )
  ) {
    fail('scope.currentScope.categories contains an unknown category');
  }

  const desiredRaw = value['desiredFeatures'];
  const workstreamsRaw = value['workstreams'];
  const gatesRaw = value['approvalGates'];
  if (!Array.isArray(desiredRaw) || !Array.isArray(workstreamsRaw)) {
    fail('scope.desiredFeatures and scope.workstreams must be arrays');
  }
  if (!Array.isArray(gatesRaw)) {
    fail('scope.approvalGates must be an array');
  }

  const desiredFeatures: DesiredFeature[] = desiredRaw.map((raw, index) => {
    if (!isRecord(raw)) fail(`desiredFeatures[${index}] must be an object`);
    const id = raw['id'];
    const kind = raw['kind'];
    const specification = raw['specification'];
    if (
      typeof id !== 'string' ||
      typeof kind !== 'string' ||
      typeof specification !== 'string' ||
      specification.length < 20
    ) {
      fail(
        `desiredFeatures[${index}] lacks an id, kind, or full specification`,
      );
    }
    return {
      id,
      kind: kind as DesiredFeature['kind'],
      specification,
      acceptance: strings(
        raw['acceptance'],
        `desiredFeatures[${index}].acceptance`,
      ),
      allowedPaths: strings(
        raw['allowedPaths'],
        `desiredFeatures[${index}].allowedPaths`,
      ),
      validate: strings(raw['validate'], `desiredFeatures[${index}].validate`),
    };
  });

  const workstreams: Workstream[] = workstreamsRaw.map((raw, index) => {
    if (!isRecord(raw)) fail(`workstreams[${index}] must be an object`);
    const id = raw['id'];
    const title = raw['title'];
    const objective = raw['objective'];
    if (
      typeof id !== 'string' ||
      typeof title !== 'string' ||
      typeof objective !== 'string' ||
      objective.length < 20
    ) {
      fail(`workstreams[${index}] lacks an id, title, or full objective`);
    }
    return {
      id,
      title,
      objective,
      validate: strings(raw['validate'], `workstreams[${index}].validate`),
    };
  });

  const approvalGates: ApprovalGate[] = gatesRaw.map((raw, index) => {
    if (!isRecord(raw)) fail(`approvalGates[${index}] must be an object`);
    const id = raw['id'];
    const after = raw['after'];
    const message = raw['message'];
    if (
      typeof id !== 'string' ||
      typeof after !== 'string' ||
      typeof message !== 'string' ||
      message.length < 20
    ) {
      fail(`approvalGates[${index}] lacks id, after, or message`);
    }
    return {id, after, message};
  });

  const taskIds = [
    ...desiredFeatures.map(feature => `feature-${feature.id}`),
    ...workstreams.map(workstream => workstream.id),
  ];
  assertUnique(taskIds, 'workflow task list');
  assertUnique(
    approvalGates.map(gate => gate.id),
    'approval gates',
  );
  const knownTasks = new Set(taskIds);
  for (const gate of approvalGates) {
    if (!knownTasks.has(gate.after)) {
      fail(`approval gate '${gate.id}' follows unknown task '${gate.after}'`);
    }
  }

  const name = value['name'];
  const languageVersion = target['languageVersion'];
  if (typeof name !== 'string' || typeof languageVersion !== 'string') {
    fail('scope.name and scope.target.languageVersion are required strings');
  }

  return {
    version: 1,
    name,
    target: {languageVersion, policy},
    currentScope: {
      categories: categories as ReferenceCategory[],
      sourceOfTruth: strings(
        current['sourceOfTruth'],
        'currentScope.sourceOfTruth',
      ),
    },
    desiredFeatures,
    publicationRules: strings(value['publicationRules'], 'publicationRules'),
    excludedSymbols: strings(value['excludedSymbols'], 'excludedSymbols'),
    reviewRequired: strings(value['reviewRequired'], 'reviewRequired'),
    allowedPaths: strings(value['allowedPaths'], 'allowedPaths'),
    approvalGates,
    workstreams,
  };
}

export function buildTaskList(scope: ReferenceScope): WorkflowTask[] {
  const desired = scope.desiredFeatures.map<WorkflowTask>(feature => ({
    id: `feature-${feature.id}`,
    title: `Implement desired feature: ${feature.id}`,
    kind: 'desired-feature',
    objective: [
      `Tea version ${scope.target.languageVersion} must include the desired ${feature.kind} '${feature.id}'.`,
      feature.specification,
      'Acceptance requirements:',
      ...feature.acceptance.map(item => `- ${item}`),
      'If the feature already exists, verify every acceptance requirement and repair any discrepancy. If it is missing, implement the full source, checker, IR, runtime, and target behavior required by the specification before later documentation workstreams publish it.',
    ].join('\n'),
    validate: feature.validate,
    allowedPaths: [...scope.allowedPaths, ...feature.allowedPaths],
  }));
  return [
    ...desired,
    ...scope.workstreams.map<WorkflowTask>(workstream => ({
      ...workstream,
      kind: 'documentation',
      allowedPaths: scope.allowedPaths,
    })),
  ];
}

export async function collectInventory(
  root: string,
  languageVersion: string,
): Promise<Inventory> {
  const variables: string[] = [];
  const constants: string[] = [];
  for (const variable of CATALOG.vars.values()) {
    if (variable.qualifier === Qualifier.Const) constants.push(variable.name);
    else variables.push(variable.name);
  }

  const nativeFunctions = [...CATALOG.funcs.entries()].map(
    ([name, overloads]) => ({
      name,
      overloads: overloads.length,
      stagedParameters: [
        ...new Set(
          overloads.flatMap(overload =>
            overload.params
              .filter(parameter => parameter.availability === 'staged')
              .map(parameter => parameter.name),
          ),
        ),
      ].sort(),
    }),
  );

  const taSource = await readFile(
    path.join(root, 'src/tea-lib/ta.tea'),
    'utf8',
  );
  const taExports = [
    ...taSource.matchAll(/^export\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm),
  ]
    .map(match => match[1]!)
    .sort();

  return {
    languageVersion,
    types: PUBLIC_TYPE_CATALOG.map(type => type.name).sort(),
    variables: variables.sort(),
    constants: constants.sort(),
    nativeFunctions: nativeFunctions.sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    keywords: [...KEYWORDS].sort(),
    operators: [
      '=',
      ...Object.values(AssignOp),
      ...Object.values(Op),
      '?:',
      '[] history',
      '. selector',
    ],
    annotations: ['//@version'],
    taExports,
  };
}

export function parseThreadId(jsonl: string): string | undefined {
  for (const line of jsonl.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      const event = JSON.parse(line) as unknown;
      if (
        isRecord(event) &&
        event['type'] === 'thread.started' &&
        typeof event['thread_id'] === 'string'
      ) {
        return event['thread_id'];
      }
    } catch {
      // The caller will retain the original stream for diagnosis.
    }
  }
  return undefined;
}

function normalizedPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function pathAllowed(
  file: string,
  allowedPaths: readonly string[],
): boolean {
  const candidate = normalizedPath(file);
  return allowedPaths.some(raw => {
    const allowed = normalizedPath(raw);
    return allowed.endsWith('/')
      ? candidate.startsWith(allowed)
      : candidate === allowed;
  });
}

export function buildPrompt(args: {
  readonly scope: ReferenceScope;
  readonly task: WorkflowTask;
  readonly inventoryFile: string;
  readonly scopeFile: string;
  readonly priorSummaries: readonly string[];
  readonly repair?: string;
}): string {
  const {scope, task} = args;
  return `# Tea exhaustive reference workflow\n\nYou are one serial Codex worker in a resumable repository workflow. Do not spawn subagents, delegate to an agent swarm, invoke another Codex process, or commit/push changes. Work directly in the current repository and finish the bounded task below.\n\n## Task\n\n**${task.title}**\n\n${task.objective}\n\n## Authoritative inputs\n\n- Scope snapshot: ${args.scopeFile}\n- Compiler inventory: ${args.inventoryFile}\n- Tea language version: ${scope.target.languageVersion}\n- Task kind: ${task.kind}\n\nRead every applicable AGENTS.md before editing. Inspect the owning compiler/runtime source and existing tests; never infer a public contract from a name alone. Preserve unrelated worktree changes. Do not modify scripts/reference-docs unless this task explicitly targets the workflow itself.\n\n## Publication rules\n\n${scope.publicationRules.map(rule => `- ${rule}`).join('\n')}\n\n## Explicit exclusions\n\n${scope.excludedSymbols.map(item => `- ${item}`).join('\n')}\n\n## Items requiring an explicit public/internal decision\n\n${scope.reviewRequired.map(item => `- ${item}`).join('\n')}\n\n## Allowed paths\n\n${task.allowedPaths.map(item => `- ${item}`).join('\n')}\n\nDo not touch a path outside this list. Do not paper over missing implementation. For a normal documentation task, omit unsupported behavior and report it in the structured result. Only a desired-feature task may implement missing language/runtime semantics, and only according to its supplied specification and acceptance criteria.\n\n## Required execution\n\n1. Audit the complete task-owned surface against the compiler inventory and source-of-truth files.\n2. Implement the task fully; do not stop at a plan, sample, placeholder, or partial catalog.\n3. Add or update completeness tests and compile/run documentation examples.\n4. Run the task validation commands where practical; the outer workflow runs them again.\n5. Re-read every rendered entry as user-facing documentation and remove compiler/project-status jargon.\n6. Return the schema-constrained result. Use status completed only when this task has no remaining work.\n\n## Prior completed work\n\n${args.priorSummaries.length === 0 ? '- None' : args.priorSummaries.map(summary => `- ${summary}`).join('\n')}\n${args.repair === undefined ? '' : `\n## Repair turn\n\nThe outer workflow found the following failure. Fix it in this same session, rerun validation, and return a new complete structured result.\n\n${args.repair}\n`}\n`;
}

async function runProcess(
  command: string,
  args: readonly string[],
  options: {readonly cwd: string; readonly input?: string},
): Promise<ProcessResult> {
  return new Promise((accept, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', code =>
      accept({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
    child.stdin.end(options.input);
  });
}

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await runProcess('git', args, {cwd: root});
  if (result.code !== 0) fail(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

async function changedPaths(root: string): Promise<string[]> {
  const tracked = await git(root, 'diff', '--name-only', 'HEAD');
  const untracked = await git(
    root,
    'ls-files',
    '--others',
    '--exclude-standard',
  );
  return [...new Set([...tracked.split('\n'), ...untracked.split('\n')])]
    .filter(Boolean)
    .map(normalizedPath)
    .sort();
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), {recursive: true});
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8')) as unknown;
}

function validateResult(value: unknown): WorkflowResult {
  if (!isRecord(value)) fail('Codex final result is not an object');
  const status = value['status'];
  const summary = value['summary'];
  if (
    (status !== 'completed' && status !== 'blocked') ||
    typeof summary !== 'string'
  ) {
    fail('Codex final result has an invalid status or summary');
  }
  return value as unknown as WorkflowResult;
}

async function runValidation(
  root: string,
  commands: readonly string[],
): Promise<ValidationResult> {
  const output: string[] = [];
  for (const command of commands) {
    output.push(`$ ${command}`);
    const shell = process.env['SHELL'] ?? '/bin/sh';
    const result = await runProcess(shell, ['-lc', command], {cwd: root});
    output.push(result.stdout, result.stderr);
    if (result.code !== 0) {
      output.push(`exit ${result.code}`);
      return {ok: false, log: output.join('\n')};
    }
  }
  return {ok: true, log: output.join('\n')};
}

function truncate(value: string, max = 24_000): string {
  return value.length <= max
    ? value
    : `${value.slice(-max)}\n[earlier output omitted]`;
}

function latestGate(
  scope: ReferenceScope,
  state: RunState,
): ApprovalGate | undefined {
  for (const gate of scope.approvalGates) {
    const task = state.tasks.find(candidate => candidate.id === gate.after);
    if (
      task?.status === 'completed' &&
      !state.approvedGates.includes(gate.id)
    ) {
      return gate;
    }
  }
  return undefined;
}

export function gateBeforeTask(
  scope: ReferenceScope,
  state: RunState,
  tasks: readonly WorkflowTask[],
  nextTaskId: string,
): ApprovalGate | undefined {
  const nextIndex = tasks.findIndex(task => task.id === nextTaskId);
  for (const gate of scope.approvalGates) {
    const gateIndex = tasks.findIndex(task => task.id === gate.after);
    if (
      gateIndex >= 0 &&
      nextIndex > gateIndex &&
      !state.approvedGates.includes(gate.id)
    ) {
      return gate;
    }
  }
  return undefined;
}

async function saveState(runDir: string, state: RunState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await writeJson(path.join(runDir, 'state.json'), state);
}

async function invokeCodex(args: {
  readonly root: string;
  readonly runDir: string;
  readonly task: WorkflowTask;
  readonly taskState: TaskState;
  readonly prompt: string;
  readonly model?: string;
  readonly resume: boolean;
}): Promise<{result?: WorkflowResult; process: ProcessResult}> {
  const taskDir = path.join(args.runDir, 'tasks', args.task.id);
  await mkdir(taskDir, {recursive: true});
  const attempt = args.taskState.attempts;
  const eventsFile = path.join(taskDir, `attempt-${attempt}.events.jsonl`);
  const stderrFile = path.join(taskDir, `attempt-${attempt}.stderr.log`);
  const finalFile = path.join(taskDir, `attempt-${attempt}.final.json`);
  await writeFile(path.join(taskDir, 'prompt.md'), args.prompt);

  const commandArgs = args.resume
    ? [
        'exec',
        'resume',
        '--json',
        '--output-schema',
        path.join(args.runDir, 'result.schema.json'),
        '-o',
        finalFile,
        ...(args.model === undefined ? [] : ['--model', args.model]),
        args.taskState.threadId!,
        '-',
      ]
    : [
        'exec',
        '--sandbox',
        'workspace-write',
        '--cd',
        args.root,
        '--json',
        '--color',
        'never',
        '--output-schema',
        path.join(args.runDir, 'result.schema.json'),
        '-o',
        finalFile,
        ...(args.model === undefined ? [] : ['--model', args.model]),
        '-',
      ];
  const processResult = await runProcess('codex', commandArgs, {
    cwd: args.root,
    input: args.prompt,
  });
  await writeFile(eventsFile, processResult.stdout);
  await writeFile(stderrFile, processResult.stderr);
  args.taskState.threadId ??= parseThreadId(processResult.stdout);

  let result: WorkflowResult | undefined;
  try {
    result = validateResult(await readJson(finalFile));
  } catch {
    // The process and output files carry the actionable failure.
  }
  return {result, process: processResult};
}

async function executeTask(args: {
  readonly root: string;
  readonly runDir: string;
  readonly scope: ReferenceScope;
  readonly state: RunState;
  readonly task: WorkflowTask;
  readonly maxRetries: number;
}): Promise<boolean> {
  const taskState = args.state.tasks.find(item => item.id === args.task.id)!;
  taskState.status = 'running';
  await saveState(args.runDir, args.state);
  let repair: string | undefined;

  for (let turn = 0; turn <= args.maxRetries; turn++) {
    taskState.attempts += 1;
    const priorSummaries = args.state.tasks
      .filter(item => item.status === 'completed' && item.summary !== undefined)
      .map(item => `${item.id}: ${item.summary}`);
    const prompt = buildPrompt({
      scope: args.scope,
      task: args.task,
      inventoryFile: path.join(args.runDir, 'inventory.json'),
      scopeFile: path.join(args.runDir, 'scope.snapshot.json'),
      priorSummaries,
      ...(repair === undefined ? {} : {repair}),
    });
    const invocation = await invokeCodex({
      root: args.root,
      runDir: args.runDir,
      task: args.task,
      taskState,
      prompt,
      ...(args.state.model === undefined ? {} : {model: args.state.model}),
      resume: turn > 0 && taskState.threadId !== undefined,
    });
    await saveState(args.runDir, args.state);

    if (invocation.result?.status === 'blocked') {
      taskState.status = 'blocked';
      taskState.summary = invocation.result.summary;
      taskState.blocker = invocation.result.remaining.join('; ');
      args.state.status = 'blocked';
      await saveState(args.runDir, args.state);
      return false;
    }

    const validation = await runValidation(args.root, args.task.validate);
    const validationFile = path.join(
      args.runDir,
      'tasks',
      args.task.id,
      `attempt-${taskState.attempts}.validation.log`,
    );
    await writeFile(validationFile, validation.log);

    const head = await git(args.root, 'rev-parse', 'HEAD');
    const currentPaths = await changedPaths(args.root);
    const newPaths = currentPaths.filter(
      file => !args.state.initialDirtyPaths.includes(file),
    );
    const unexpected = newPaths.filter(
      file => !pathAllowed(file, args.task.allowedPaths),
    );
    const result = invocation.result;
    const remaining = result?.remaining ?? ['No valid structured result'];
    const complete =
      invocation.process.code === 0 &&
      result?.status === 'completed' &&
      remaining.length === 0 &&
      validation.ok &&
      head === args.state.initialHead &&
      unexpected.length === 0;
    if (complete) {
      taskState.status = 'completed';
      taskState.summary = result.summary;
      taskState.blocker = undefined;
      await saveState(args.runDir, args.state);
      return true;
    }

    repair = truncate(
      [
        `Codex exit code: ${invocation.process.code}`,
        invocation.process.stderr,
        `Structured remaining work: ${remaining.join('; ')}`,
        `Validation passed: ${validation.ok}`,
        validation.log,
        `Git HEAD unchanged: ${head === args.state.initialHead}`,
        `Unexpected changed paths: ${unexpected.join(', ') || 'none'}`,
      ].join('\n'),
    );
  }

  taskState.status = 'blocked';
  taskState.blocker = repair ?? 'Task did not complete';
  args.state.status = 'blocked';
  await saveState(args.runDir, args.state);
  return false;
}

function selectTasks(
  tasks: readonly WorkflowTask[],
  options: CliOptions,
): WorkflowTask[] {
  let selected = [...tasks];
  if (options.from !== undefined) {
    const at = selected.findIndex(task => task.id === options.from);
    if (at < 0) fail(`--from names unknown task '${options.from}'`);
    selected = selected.slice(at);
  }
  if (options.only !== undefined) {
    const unknown = [...options.only].filter(
      id => !tasks.some(task => task.id === id),
    );
    if (unknown.length > 0)
      fail(`--only names unknown tasks: ${unknown.join(', ')}`);
    selected = selected.filter(
      task => task.kind === 'desired-feature' || options.only!.has(task.id),
    );
  }
  return selected;
}

export function incompletePredecessors(
  tasks: readonly WorkflowTask[],
  state: Pick<RunState, 'tasks'>,
  nextTaskId: string,
): string[] {
  const nextIndex = tasks.findIndex(task => task.id === nextTaskId);
  if (nextIndex < 0) return [nextTaskId];
  const completed = new Set(
    state.tasks
      .filter(task => task.status === 'completed')
      .map(task => task.id),
  );
  return tasks
    .slice(0, nextIndex)
    .map(task => task.id)
    .filter(id => !completed.has(id));
}

async function executeRun(args: {
  readonly root: string;
  readonly runDir: string;
  readonly scope: ReferenceScope;
  readonly tasks: readonly WorkflowTask[];
  readonly state: RunState;
  readonly options: CliOptions;
}): Promise<void> {
  for (const task of selectTasks(args.tasks, args.options)) {
    const taskState = args.state.tasks.find(item => item.id === task.id)!;
    if (taskState.status === 'completed') continue;
    const predecessors = incompletePredecessors(
      args.tasks,
      args.state,
      task.id,
    );
    if (predecessors.length > 0) {
      fail(
        `task '${task.id}' cannot run before its serial predecessors complete: ${predecessors.join(', ')}`,
      );
    }
    const gate =
      gateBeforeTask(args.scope, args.state, args.tasks, task.id) ??
      latestGate(args.scope, args.state);
    if (gate !== undefined) {
      args.state.status = 'waiting-approval';
      await saveState(args.runDir, args.state);
      console.log(`Waiting for approval '${gate.id}': ${gate.message}`);
      console.log(
        `Review the pilot, update the workflow with feedback, then run: node --import tsx scripts/reference-docs/workflow.ts approve ${args.state.runId} ${gate.id}`,
      );
      return;
    }
    console.log(`\n==> ${task.id}: ${task.title}`);
    if (
      !(await executeTask({
        root: args.root,
        runDir: args.runDir,
        scope: args.scope,
        state: args.state,
        task,
        maxRetries: args.options.maxRetries,
      }))
    ) {
      console.error(`Stopped at blocked task '${task.id}'.`);
      process.exitCode = 1;
      return;
    }
  }
  const gate = latestGate(args.scope, args.state);
  if (gate !== undefined) {
    args.state.status = 'waiting-approval';
    await saveState(args.runDir, args.state);
    console.log(`Waiting for approval '${gate.id}': ${gate.message}`);
    return;
  }
  args.state.status = args.state.tasks.every(
    task => task.status === 'completed',
  )
    ? 'completed'
    : 'active';
  await saveState(args.runDir, args.state);
  console.log(`Run ${args.state.runId}: ${args.state.status}`);
}

function optionValue(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--')) {
    fail(`${name} requires a value`);
  }
  args.splice(at, 2);
  return value;
}

export function parseCli(argv: readonly string[]): CliOptions {
  const args = [...argv];
  const command = (args.shift() ?? 'plan') as CliOptions['command'];
  if (!['plan', 'run', 'resume', 'status', 'approve'].includes(command)) {
    fail(`unknown command '${command}'`);
  }
  const scopeFile = optionValue(args, '--scope') ?? DEFAULT_SCOPE;
  const model =
    optionValue(args, '--model') ?? process.env['TEA_DOCS_CODEX_MODEL'];
  const onlyValue = optionValue(args, '--only');
  const from = optionValue(args, '--from');
  const runId = optionValue(args, '--run-id');
  const retriesText = optionValue(args, '--max-retries') ?? '2';
  const maxRetries = Number(retriesText);
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
    fail('--max-retries must be an integer from 0 through 10');
  }
  const allowDirtyAt = args.indexOf('--allow-dirty');
  const allowDirty = allowDirtyAt >= 0;
  if (allowDirty) args.splice(allowDirtyAt, 1);
  const positional = args.filter(arg => !arg.startsWith('--'));
  const unknownFlags = args.filter(arg => arg.startsWith('--'));
  if (unknownFlags.length > 0)
    fail(`unknown options: ${unknownFlags.join(', ')}`);
  return {
    command,
    positional,
    scopeFile,
    ...(model === undefined ? {} : {model}),
    ...(onlyValue === undefined
      ? {}
      : {only: new Set(onlyValue.split(',').filter(Boolean))}),
    ...(from === undefined ? {} : {from}),
    maxRetries,
    allowDirty,
    ...(runId === undefined ? {} : {runId}),
  };
}

async function loadScope(file: string): Promise<{
  readonly scope: ReferenceScope;
  readonly raw: string;
  readonly absolute: string;
}> {
  const absolute = path.resolve(file);
  const raw = await readFile(absolute, 'utf8');
  return {scope: validateScope(JSON.parse(raw) as unknown), raw, absolute};
}

async function repoRoot(): Promise<string> {
  const result = await runProcess('git', ['rev-parse', '--show-toplevel'], {
    cwd: process.cwd(),
  });
  if (result.code !== 0)
    fail('reference workflow must run inside a Git repository');
  return result.stdout.trim();
}

async function preflight(root: string): Promise<string> {
  const version = await runProcess('codex', ['--version'], {cwd: root});
  if (version.code !== 0) fail('codex CLI is unavailable');
  const help = await runProcess('codex', ['exec', '--help'], {cwd: root});
  for (const flag of ['--json', '--output-schema', '--output-last-message']) {
    if (!help.stdout.includes(flag)) fail(`installed codex exec lacks ${flag}`);
  }
  return version.stdout.trim();
}

function defaultRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function newRun(options: CliOptions): Promise<void> {
  const root = await repoRoot();
  const loaded = await loadScope(options.scopeFile);
  const tasks = buildTaskList(loaded.scope);
  const dirty = await changedPaths(root);
  if (dirty.length > 0 && !options.allowDirty) {
    fail(
      `worktree is dirty (${dirty.length} paths); use a dedicated clean worktree or pass --allow-dirty after backing it up`,
    );
  }
  const runId = options.runId ?? defaultRunId();
  const runDir = path.join(root, RUNS_DIR, runId);
  await mkdir(path.dirname(runDir), {recursive: true});
  try {
    await mkdir(runDir, {recursive: false});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      fail(`reference workflow run '${runId}' already exists`);
    }
    throw error;
  }
  const codexVersion = await preflight(root);
  const inventory = await collectInventory(
    root,
    loaded.scope.target.languageVersion,
  );
  await writeFile(path.join(runDir, 'scope.snapshot.json'), loaded.raw);
  await writeJson(path.join(runDir, 'inventory.json'), inventory);
  await copyFile(RESULT_SCHEMA, path.join(runDir, 'result.schema.json'));
  const state: RunState = {
    version: 1,
    runId,
    root,
    initialHead: await git(root, 'rev-parse', 'HEAD'),
    initialDirtyPaths: dirty,
    scopeHash: hash(loaded.raw),
    scopeFile: loaded.absolute,
    codexVersion,
    ...(options.model === undefined ? {} : {model: options.model}),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'active',
    approvedGates: [],
    tasks: tasks.map(task => ({
      id: task.id,
      title: task.title,
      kind: task.kind,
      status: 'pending',
      attempts: 0,
    })),
  };
  await saveState(runDir, state);
  console.log(`Created reference workflow run ${runId}`);
  await executeRun({root, runDir, scope: loaded.scope, tasks, state, options});
}

async function loadRun(
  root: string,
  runId: string,
): Promise<{
  readonly runDir: string;
  readonly scope: ReferenceScope;
  readonly tasks: WorkflowTask[];
  readonly state: RunState;
}> {
  const runDir = path.join(root, RUNS_DIR, runId);
  const scope = validateScope(
    await readJson(path.join(runDir, 'scope.snapshot.json')),
  );
  const state = (await readJson(path.join(runDir, 'state.json'))) as RunState;
  return {runDir, scope, tasks: buildTaskList(scope), state};
}

async function resumeRun(options: CliOptions): Promise<void> {
  const runId = options.positional[0];
  if (runId === undefined) fail('resume requires a run id');
  const root = await repoRoot();
  const run = await loadRun(root, runId);
  if ((await git(root, 'rev-parse', 'HEAD')) !== run.state.initialHead) {
    fail('Git HEAD changed since this run started; start a new workflow run');
  }
  if (run.state.status === 'blocked') run.state.status = 'active';
  await executeRun({...run, root, options});
}

async function showStatus(options: CliOptions): Promise<void> {
  const root = await repoRoot();
  const runId = options.positional[0];
  if (runId === undefined) {
    const directory = path.join(root, RUNS_DIR);
    let runs: string[] = [];
    try {
      runs = await readdir(directory);
    } catch {
      // No runs yet.
    }
    console.log(runs.sort().join('\n') || 'No reference workflow runs.');
    return;
  }
  const {state} = await loadRun(root, runId);
  console.log(`Run ${runId}: ${state.status}`);
  for (const task of state.tasks) {
    console.log(
      `${task.status.padEnd(10)} ${task.id} (${task.attempts} turns)`,
    );
  }
}

async function approveGate(options: CliOptions): Promise<void> {
  const [runId, gateId] = options.positional;
  if (runId === undefined || gateId === undefined) {
    fail('approve requires a run id and gate id');
  }
  const root = await repoRoot();
  const run = await loadRun(root, runId);
  const gate = run.scope.approvalGates.find(item => item.id === gateId);
  if (gate === undefined) fail(`unknown approval gate '${gateId}'`);
  const predecessor = run.state.tasks.find(task => task.id === gate.after);
  if (predecessor?.status !== 'completed') {
    fail(`cannot approve '${gateId}' before task '${gate.after}' completes`);
  }
  if (!run.state.approvedGates.includes(gateId)) {
    run.state.approvedGates.push(gateId);
  }
  run.state.status = 'active';
  await saveState(run.runDir, run.state);
  console.log(`Approved gate ${gateId} for run ${runId}.`);
  console.log(
    `Resume with: node --import tsx scripts/reference-docs/workflow.ts resume ${runId}`,
  );
}

async function printPlan(options: CliOptions): Promise<void> {
  const loaded = await loadScope(options.scopeFile);
  const tasks = selectTasks(buildTaskList(loaded.scope), options);
  console.log(
    `${loaded.scope.name} (Tea ${loaded.scope.target.languageVersion})`,
  );
  for (const [index, task] of tasks.entries()) {
    console.log(
      `${String(index + 1).padStart(2, ' ')}. ${task.id}: ${task.title}`,
    );
    const gate = loaded.scope.approvalGates.find(
      item => item.after === task.id,
    );
    if (gate !== undefined)
      console.log(`    HUMAN GATE ${gate.id}: ${gate.message}`);
  }
}

export async function main(argv: readonly string[]): Promise<void> {
  const options = parseCli(argv);
  switch (options.command) {
    case 'plan':
      return printPlan(options);
    case 'run':
      return newRun(options);
    case 'resume':
      return resumeRun(options);
    case 'status':
      return showStatus(options);
    case 'approve':
      return approveGate(options);
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === SCRIPT_FILE
) {
  await main(process.argv.slice(2)).catch(error => {
    console.error(
      `reference-docs: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
