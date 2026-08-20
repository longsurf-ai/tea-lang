// Purpose: Strict parsers for hash-pinned execution corpus manifests, references, and the exact intentional-deviation ledger.

import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {expect} from 'vitest';

export type JsonScalar = string | number | boolean | null;

export interface CorpusCase {
  readonly id: string;
  readonly kind: 'compile-through' | 'differential';
  readonly source: string;
  readonly data: string;
  readonly reference: string;
  readonly sha256: {
    readonly source: string;
    readonly data: string;
    readonly reference: string;
  };
}

export interface CorpusManifest {
  readonly version: 1;
  readonly cases: readonly CorpusCase[];
  readonly deviations: {readonly path: string; readonly sha256: string};
}

interface ExpectedOutput {
  readonly oid: number;
  readonly effect: string;
  readonly staticArgs: readonly (readonly [string, JsonScalar])[];
  readonly boundArgs: readonly (readonly [string, JsonScalar])[];
  readonly channels: readonly (readonly [string, string])[];
}

interface ExpectedEmission {
  readonly oid: number;
  readonly provisional: boolean;
  readonly channels: readonly JsonScalar[];
}

type ExpectedInputConstraint =
  | {
      readonly kind: 'range';
      readonly minval: number | null;
      readonly maxval: number | null;
      readonly step: number | null;
    }
  | {readonly kind: 'options'; readonly options: readonly JsonScalar[]};

interface ExpectedInputSpec {
  readonly name: string;
  readonly title: string | null;
  readonly type:
    | 'int'
    | 'float'
    | 'bool'
    | 'string'
    | 'color'
    | 'source'
    | 'enum';
  readonly control: string;
  readonly defaultValue: JsonScalar;
  readonly constraints: ExpectedInputConstraint | null;
  readonly enumType: {
    readonly name: string;
    readonly members: readonly {
      readonly name: string;
      readonly title: string;
    }[];
  } | null;
  readonly group: string | null;
  readonly inline: string | null;
  readonly tooltip: string | null;
  readonly confirm: boolean;
  readonly display: 'all' | 'none' | 'data_window' | 'status_line';
  readonly seriesSid: number | null;
}

interface ExpectedInput {
  readonly spec: ExpectedInputSpec;
  readonly value: JsonScalar;
  readonly active: boolean;
}

export interface ExpectedBinding {
  readonly name: string;
  readonly params: readonly (readonly [string, JsonScalar])[];
  readonly inputs: readonly ExpectedInput[];
}

export interface ExpectedReference {
  readonly version: 1;
  readonly oracle: {
    readonly kind: 'hand-derived' | 'specification-derived' | 'tea-contract';
    readonly description: string;
    readonly references: readonly string[];
  };
  readonly tolerance: {readonly absolute: number; readonly relative: number};
  readonly outputs: readonly ExpectedOutput[];
  readonly rows: readonly {
    readonly row: number;
    readonly emissions: readonly ExpectedEmission[];
  }[];
  readonly bindings: readonly ExpectedBinding[];
  readonly deviations: readonly string[];
}

export interface Deviation {
  readonly id: string;
  readonly caseId: string;
  readonly summary: string;
  readonly teaBehavior: string;
  readonly referenceBehavior: string;
  readonly rationale: string;
  readonly reference: string;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function keys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  expect(Object.keys(value).sort(), `${label} keys`).toEqual(
    [...expected].sort(),
  );
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label);
}

function hash(value: unknown, label: string): string {
  const text = string(value, label);
  if (!/^[0-9a-f]{64}$/.test(text)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return text;
}

function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  const n = number(value, label);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return n;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function scalar(value: unknown, label: string): JsonScalar {
  if (
    value !== null &&
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    typeof value !== 'boolean'
  ) {
    throw new Error(`${label} must be a JSON scalar`);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`${label} must be finite or null (na)`);
  }
  return value;
}

export function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function safeFixturePath(path: unknown, label: string): string {
  const value = string(path, label);
  if (
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').includes('..')
  ) {
    throw new Error(`${label} must stay inside tests/fixtures/execution`);
  }
  return value;
}

export function parseManifest(raw: unknown): CorpusManifest {
  const root = object(raw, 'manifest');
  keys(root, ['version', 'cases', 'deviations'], 'manifest');
  expect(root['version']).toBe(1);
  const seen = new Set<string>();
  const cases = array(root['cases'], 'manifest.cases').map((entry, i) => {
    const value = object(entry, `manifest.cases[${i}]`);
    keys(
      value,
      ['id', 'kind', 'source', 'data', 'reference', 'sha256'],
      `manifest.cases[${i}]`,
    );
    const id = string(value['id'], `manifest.cases[${i}].id`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || seen.has(id)) {
      throw new Error(`manifest case id '${id}' is invalid or duplicated`);
    }
    seen.add(id);
    const kind = value['kind'];
    if (kind !== 'compile-through' && kind !== 'differential') {
      throw new Error(`manifest case '${id}' has invalid kind`);
    }
    const source = safeFixturePath(value['source'], `${id}.source`);
    const data = safeFixturePath(value['data'], `${id}.data`);
    const reference = safeFixturePath(value['reference'], `${id}.reference`);
    const prefix = `${kind === 'compile-through' ? 'compile' : 'differential'}/${id}/`;
    for (const path of [source, data, reference]) {
      if (!path.startsWith(prefix)) {
        throw new Error(
          `manifest case '${id}' path '${path}' escapes its case`,
        );
      }
    }
    const hashes = object(value['sha256'], `${id}.sha256`);
    keys(hashes, ['source', 'data', 'reference'], `${id}.sha256`);
    return {
      id,
      kind,
      source,
      data,
      reference,
      sha256: {
        source: hash(hashes['source'], `${id}.sha256.source`),
        data: hash(hashes['data'], `${id}.sha256.data`),
        reference: hash(hashes['reference'], `${id}.sha256.reference`),
      },
    } satisfies CorpusCase;
  });
  const deviations = object(root['deviations'], 'manifest.deviations');
  keys(deviations, ['path', 'sha256'], 'manifest.deviations');
  return {
    version: 1,
    cases,
    deviations: {
      path: safeFixturePath(deviations['path'], 'manifest.deviations.path'),
      sha256: hash(deviations['sha256'], 'manifest.deviations.sha256'),
    },
  };
}

function pairs(
  value: unknown,
  label: string,
): readonly (readonly [string, JsonScalar])[] {
  return array(value, label).map((entry, i) => {
    const pair = array(entry, `${label}[${i}]`);
    if (pair.length !== 2) {
      throw new Error(`${label}[${i}] must contain exactly two values`);
    }
    return [
      string(pair[0], `${label}[${i}][0]`),
      scalar(pair[1], `${label}[${i}][1]`),
    ] as const;
  });
}

function nullableNumber(value: unknown, label: string): number | null {
  return value === null ? null : number(value, label);
}

function parseConstraint(
  raw: unknown,
  label: string,
): ExpectedInputConstraint | null {
  if (raw === null) {
    return null;
  }
  const value = object(raw, label);
  if (value['kind'] === 'range') {
    keys(value, ['kind', 'minval', 'maxval', 'step'], label);
    return {
      kind: 'range',
      minval: nullableNumber(value['minval'], `${label}.minval`),
      maxval: nullableNumber(value['maxval'], `${label}.maxval`),
      step: nullableNumber(value['step'], `${label}.step`),
    };
  }
  if (value['kind'] === 'options') {
    keys(value, ['kind', 'options'], label);
    const options = array(value['options'], `${label}.options`).map(
      (entry, i) => scalar(entry, `${label}.options[${i}]`),
    );
    if (options.length === 0) {
      throw new Error(`${label}.options must not be empty`);
    }
    return {kind: 'options', options};
  }
  throw new Error(`${label}.kind is invalid`);
}

function parseEnumType(
  raw: unknown,
  label: string,
): ExpectedInputSpec['enumType'] {
  if (raw === null) {
    return null;
  }
  const value = object(raw, label);
  keys(value, ['name', 'members'], label);
  const members = array(value['members'], `${label}.members`).map(
    (entry, i) => {
      const member = object(entry, `${label}.members[${i}]`);
      keys(member, ['name', 'title'], `${label}.members[${i}]`);
      return {
        name: string(member['name'], `${label}.members[${i}].name`),
        title: text(member['title'], `${label}.members[${i}].title`),
      };
    },
  );
  if (members.length === 0) {
    throw new Error(`${label}.members must not be empty`);
  }
  return {name: string(value['name'], `${label}.name`), members};
}

function parseInput(raw: unknown, label: string): ExpectedInput {
  const value = object(raw, label);
  keys(value, ['spec', 'value', 'active'], label);
  const spec = object(value['spec'], `${label}.spec`);
  keys(
    spec,
    [
      'name',
      'title',
      'type',
      'control',
      'defaultValue',
      'constraints',
      'enumType',
      'group',
      'inline',
      'tooltip',
      'confirm',
      'display',
      'seriesSid',
    ],
    `${label}.spec`,
  );
  const type = spec['type'];
  if (
    type !== 'int' &&
    type !== 'float' &&
    type !== 'bool' &&
    type !== 'string' &&
    type !== 'color' &&
    type !== 'source' &&
    type !== 'enum'
  ) {
    throw new Error(`${label}.spec.type is invalid`);
  }
  const display = spec['display'];
  if (
    display !== 'all' &&
    display !== 'none' &&
    display !== 'data_window' &&
    display !== 'status_line'
  ) {
    throw new Error(`${label}.spec.display is invalid`);
  }
  const seriesSid = spec['seriesSid'];
  return {
    spec: {
      name: string(spec['name'], `${label}.spec.name`),
      title: nullableText(spec['title'], `${label}.spec.title`),
      type,
      control: string(spec['control'], `${label}.spec.control`),
      defaultValue: scalar(spec['defaultValue'], `${label}.spec.defaultValue`),
      constraints: parseConstraint(
        spec['constraints'],
        `${label}.spec.constraints`,
      ),
      enumType: parseEnumType(spec['enumType'], `${label}.spec.enumType`),
      group: nullableText(spec['group'], `${label}.spec.group`),
      inline: nullableText(spec['inline'], `${label}.spec.inline`),
      tooltip: nullableText(spec['tooltip'], `${label}.spec.tooltip`),
      confirm: boolean(spec['confirm'], `${label}.spec.confirm`),
      display,
      seriesSid:
        seriesSid === null
          ? null
          : integer(seriesSid, `${label}.spec.seriesSid`),
    },
    value: scalar(value['value'], `${label}.value`),
    active: boolean(value['active'], `${label}.active`),
  };
}

function parseBindings(
  raw: unknown,
  label: string,
): readonly ExpectedBinding[] {
  const names = new Set<string>();
  const bindings = array(raw, label).map((entry, i) => {
    const value = object(entry, `${label}[${i}]`);
    keys(value, ['name', 'params', 'inputs'], `${label}[${i}]`);
    const name = string(value['name'], `${label}[${i}].name`);
    if (names.has(name)) {
      throw new Error(`${label} contains duplicate scenario '${name}'`);
    }
    names.add(name);
    const params = pairs(value['params'], `${label}[${i}].params`);
    if (new Set(params.map(([param]) => param)).size !== params.length) {
      throw new Error(`${label}[${i}].params contains a duplicate name`);
    }
    const inputs = array(value['inputs'], `${label}[${i}].inputs`).map(
      (input, n) => parseInput(input, `${label}[${i}].inputs[${n}]`),
    );
    if (new Set(inputs.map(input => input.spec.name)).size !== inputs.length) {
      throw new Error(`${label}[${i}].inputs contains a duplicate name`);
    }
    if (inputs.length === 0) {
      throw new Error(`${label}[${i}].inputs must not be empty`);
    }
    return {name, params, inputs};
  });
  if (bindings.length === 0) {
    throw new Error(`${label} must not be empty when present`);
  }
  return bindings;
}

export function parseReference(raw: unknown, label: string): ExpectedReference {
  const root = object(raw, label);
  const hasBindings = Object.hasOwn(root, 'bindings');
  keys(
    root,
    [
      'version',
      'oracle',
      'tolerance',
      'outputs',
      'rows',
      ...(hasBindings ? ['bindings'] : []),
      'deviations',
    ],
    label,
  );
  expect(root['version']).toBe(1);
  const oracle = object(root['oracle'], `${label}.oracle`);
  keys(oracle, ['kind', 'description', 'references'], `${label}.oracle`);
  const oracleKind = oracle['kind'];
  if (
    oracleKind !== 'hand-derived' &&
    oracleKind !== 'specification-derived' &&
    oracleKind !== 'tea-contract'
  ) {
    throw new Error(`${label}.oracle.kind is invalid`);
  }
  const tolerance = object(root['tolerance'], `${label}.tolerance`);
  keys(tolerance, ['absolute', 'relative'], `${label}.tolerance`);
  const absolute = number(tolerance['absolute'], `${label}.tolerance.absolute`);
  const relative = number(tolerance['relative'], `${label}.tolerance.relative`);
  if (absolute < 0 || relative < 0) {
    throw new Error(`${label}.tolerance cannot be negative`);
  }
  const outputs = array(root['outputs'], `${label}.outputs`).map((entry, i) => {
    const output = object(entry, `${label}.outputs[${i}]`);
    keys(
      output,
      ['oid', 'effect', 'staticArgs', 'boundArgs', 'channels'],
      `${label}.outputs[${i}]`,
    );
    const channels = array(
      output['channels'],
      `${label}.outputs[${i}].channels`,
    ).map((entry, c) => {
      const pair = array(entry, `${label}.outputs[${i}].channels[${c}]`);
      if (pair.length !== 2) {
        throw new Error(`${label}.outputs[${i}].channels[${c}] must be a pair`);
      }
      return [
        string(pair[0], `${label}.outputs[${i}].channels[${c}][0]`),
        string(pair[1], `${label}.outputs[${i}].channels[${c}][1]`),
      ] as const;
    });
    return {
      oid: integer(output['oid'], `${label}.outputs[${i}].oid`),
      effect: string(output['effect'], `${label}.outputs[${i}].effect`),
      staticArgs: pairs(
        output['staticArgs'],
        `${label}.outputs[${i}].staticArgs`,
      ),
      boundArgs: pairs(output['boundArgs'], `${label}.outputs[${i}].boundArgs`),
      channels,
    };
  });
  const rows = array(root['rows'], `${label}.rows`).map((entry, i) => {
    const row = object(entry, `${label}.rows[${i}]`);
    keys(row, ['row', 'emissions'], `${label}.rows[${i}]`);
    const emissions = array(
      row['emissions'],
      `${label}.rows[${i}].emissions`,
    ).map((entry, e) => {
      const emission = object(entry, `${label}.rows[${i}].emissions[${e}]`);
      keys(
        emission,
        ['oid', 'provisional', 'channels'],
        `${label}.rows[${i}].emissions[${e}]`,
      );
      return {
        oid: integer(
          emission['oid'],
          `${label}.rows[${i}].emissions[${e}].oid`,
        ),
        provisional: boolean(
          emission['provisional'],
          `${label}.rows[${i}].emissions[${e}].provisional`,
        ),
        channels: array(
          emission['channels'],
          `${label}.rows[${i}].emissions[${e}].channels`,
        ).map((value, c) =>
          scalar(value, `${label}.rows[${i}].emissions[${e}].channels[${c}]`),
        ),
      };
    });
    return {row: integer(row['row'], `${label}.rows[${i}].row`), emissions};
  });
  return {
    version: 1,
    oracle: {
      kind: oracleKind,
      description: string(oracle['description'], `${label}.oracle.description`),
      references: array(oracle['references'], `${label}.oracle.references`).map(
        (value, i) => string(value, `${label}.oracle.references[${i}]`),
      ),
    },
    tolerance: {absolute, relative},
    outputs,
    rows,
    bindings: hasBindings
      ? parseBindings(root['bindings'], `${label}.bindings`)
      : [],
    deviations: array(root['deviations'], `${label}.deviations`).map(
      (value, i) => string(value, `${label}.deviations[${i}]`),
    ),
  };
}

export function parseDeviations(raw: unknown): readonly Deviation[] {
  const root = object(raw, 'deviation ledger');
  keys(root, ['version', 'deviations'], 'deviation ledger');
  expect(root['version']).toBe(1);
  const seen = new Set<string>();
  return array(root['deviations'], 'deviation ledger.deviations').map(
    (entry, i) => {
      const value = object(entry, `deviation ledger.deviations[${i}]`);
      keys(
        value,
        [
          'id',
          'caseId',
          'summary',
          'teaBehavior',
          'referenceBehavior',
          'rationale',
          'reference',
        ],
        `deviation ledger.deviations[${i}]`,
      );
      const id = string(value['id'], `deviation ledger.deviations[${i}].id`);
      if (seen.has(id)) {
        throw new Error(`duplicate deviation '${id}'`);
      }
      seen.add(id);
      return {
        id,
        caseId: string(value['caseId'], `${id}.caseId`),
        summary: string(value['summary'], `${id}.summary`),
        teaBehavior: string(value['teaBehavior'], `${id}.teaBehavior`),
        referenceBehavior: string(
          value['referenceBehavior'],
          `${id}.referenceBehavior`,
        ),
        rationale: string(value['rationale'], `${id}.rationale`),
        reference: string(value['reference'], `${id}.reference`),
      };
    },
  );
}
