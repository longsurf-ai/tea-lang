// Purpose: Deterministic static call-site frame projection for WGSL state.

import {fatal} from '../../base/print';
import {frameTopologyOf} from '../../ir/frames';
import {
  DepthKind,
  IrKind,
  PlaceKind,
  type IrExpr,
  type Name,
} from '../../ir/node';
import {TypeKind} from '../../ir/type';
import type {IrFunc, Program} from '../../ir/program';
import {walkIrExpr, walkIrStmt} from '../../ir/visit';

const MAX_U32 = 0xffff_ffff;
export const MAX_WGSL_HISTORY_OFFSET = 0x7fff_ffff;

export interface WgslFrameLocalLayout {
  readonly name: Name;
  readonly scratchWordOffset: number;
  readonly valueWordCount: number;
  readonly committedInitWordOffset: number | null;
  readonly tentativeInitWordOffset: number | null;
  readonly historyWordOffset: number | null;
  readonly historyCapacity: number;
}

export interface WgslFrameChildLayout {
  readonly slot: number;
  readonly callee: IrFunc;
  readonly templateId: number;
  readonly wordOffset: number;
}

export interface WgslFrameTemplateLayout {
  readonly id: number;
  readonly owner: IrFunc | null;
  readonly ownerName: string;
  readonly committedActivationWordOffset: 0;
  readonly tentativeActivationWordOffset: 1;
  // Both words encode absolute activation row + 1; zero means inactive.
  // This epoch is sufficient to distinguish unavailable pre-activation
  // history while ring addressing uses the execution's absolute row.
  readonly activationEncoding: 'absolute-row-plus-one';
  readonly locals: readonly WgslFrameLocalLayout[];
  readonly children: readonly WgslFrameChildLayout[];
  readonly wordCount: number;
}

export interface WgslFrameProjection {
  readonly templates: readonly WgslFrameTemplateLayout[];
  readonly root: WgslFrameTemplateLayout;
  readonly templateByFunc: ReadonlyMap<IrFunc, WgslFrameTemplateLayout>;
  readonly localByName: ReadonlyMap<Name, WgslFrameLocalLayout>;
  readonly ephemeralFormalsByFunc: ReadonlyMap<IrFunc, ReadonlySet<Name>>;
}

export class WgslFrameProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WgslFrameProjectionError';
  }
}

function checkedWords(value: number, owner: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_U32) {
    throw new WgslFrameProjectionError(`${owner} exceeds u32 state words`);
  }
  return value;
}

function addWords(left: number, right: number, owner: string): number {
  return checkedWords(left + right, owner);
}

function multiplyWords(left: number, right: number, owner: string): number {
  return checkedWords(left * right, owner);
}

export function projectWgslFrames(
  program: Program,
  valueWords: (name: Name) => number,
): WgslFrameProjection {
  const topology = frameTopologyOf(program);
  const funcs = topology.frames.flatMap(frame =>
    frame.owner === null ? [] : [frame.owner],
  );
  // The Program depth is target-independent and can include a constant read
  // that WGSL intentionally lowers to typed empty (for example an offset that
  // cannot be represented by the GPU row cursor). Derive the physical demand
  // from WGSL-valid read sites so such a read cannot inflate frame storage.
  const historyDemand = new Map<Name, number>();
  const noteHistoryDemand = (expr: IrExpr): void => {
    if (expr.kind !== IrKind.HistRead || expr.place.kind !== PlaceKind.Name) {
      return;
    }
    const offset = expr.offset;
    if (
      offset === null ||
      offset.kind !== IrKind.Const ||
      offset.type.kind !== TypeKind.Int ||
      typeof offset.value !== 'number' ||
      !Number.isSafeInteger(offset.value) ||
      offset.value < 0 ||
      offset.value > MAX_WGSL_HISTORY_OFFSET
    ) {
      return;
    }
    historyDemand.set(
      expr.place.name,
      Math.max(historyDemand.get(expr.place.name) ?? 0, offset.value),
    );
  };
  program.init.forEach(stmt => walkIrStmt(stmt, {expr: noteHistoryDemand}));
  program.body.forEach(stmt => walkIrStmt(stmt, {expr: noteHistoryDemand}));
  funcs.forEach(func => walkIrExpr(func.body, {expr: noteHistoryDemand}));
  const owners = topology.frames.map(frame => frame.owner);

  const layouts = new Map<IrFunc | null, WgslFrameTemplateLayout>();
  const ephemeralFormalsByFunc = new Map<IrFunc, ReadonlySet<Name>>();
  const visiting = new Set<IrFunc | null>();
  const build = (owner: IrFunc | null): WgslFrameTemplateLayout => {
    const cached = layouts.get(owner);
    if (cached !== undefined) return cached;
    if (visiting.has(owner)) {
      throw new WgslFrameProjectionError(
        `recursive static frame reaches '${owner?.name ?? '<program>'}'`,
      );
    }
    visiting.add(owner);
    let names: readonly Name[];
    if (owner === null) {
      names = topology.root.locals;
    } else {
      const parameters = [
        ...(owner.callMode === 'free' ? [] : [owner.receiver]),
        ...owner.params,
      ];
      const ephemeral = new Set(
        parameters.filter(
          name =>
            name.storage === 'perBar' && (historyDemand.get(name) ?? 0) === 0,
        ),
      );
      ephemeralFormalsByFunc.set(owner, ephemeral);
      names = [
        ...parameters.filter(name => !ephemeral.has(name)),
        ...owner.locals,
      ];
    }
    // Activation is transactional state even though the initial GPU subset
    // has no suspension: tentative is reset from committed at row start and
    // becomes durable only at row commit.
    let words = checkedWords(2, 'frame activation');
    const locals: WgslFrameLocalLayout[] = names.map(name => {
      const valueWordCount = valueWords(name);
      if (
        !Number.isSafeInteger(valueWordCount) ||
        valueWordCount <= 0 ||
        valueWordCount > MAX_U32
      ) {
        throw new WgslFrameProjectionError(
          `invalid WGSL word width for '${name.name}'`,
        );
      }
      const scratchWordOffset = words;
      words = addWords(words, valueWordCount, `'${name.name}' scratch`);
      const committedInitWordOffset = name.storage === 'perBar' ? null : words;
      if (committedInitWordOffset !== null) {
        words = addWords(words, 1, `'${name.name}' committed init`);
      }
      const tentativeInitWordOffset = name.storage === 'perBar' ? null : words;
      if (tentativeInitWordOffset !== null) {
        words = addWords(words, 1, `'${name.name}' tentative init`);
      }
      let historyCapacity: number;
      switch (name.depth.kind) {
        case DepthKind.None:
        case DepthKind.Const:
          historyCapacity = Math.max(
            name.storage === 'perBar' ? 0 : 1,
            historyDemand.get(name) ?? 0,
          );
          break;
        case DepthKind.Bound:
        case DepthKind.Capped:
          throw new WgslFrameProjectionError(
            `frame name '${name.name}' requires non-constant history`,
          );
      }
      const historyWordOffset = historyCapacity === 0 ? null : words;
      words = addWords(
        words,
        multiplyWords(
          historyCapacity,
          valueWordCount,
          `'${name.name}' history`,
        ),
        `'${name.name}' state`,
      );
      return {
        name,
        scratchWordOffset,
        valueWordCount,
        committedInitWordOffset,
        tentativeInitWordOffset,
        historyWordOffset,
        historyCapacity,
      };
    });
    const children: WgslFrameChildLayout[] = [];
    const semanticFrame =
      owner === null ? topology.root : topology.frameByFunc.get(owner);
    if (semanticFrame === undefined) {
      return fatal(
        `missing semantic frame for '${owner?.name ?? '<program>'}'`,
      );
    }
    for (const {slot, callee} of semanticFrame.children) {
      const child = build(callee);
      children.push({
        slot,
        callee,
        templateId: child.id,
        wordOffset: words,
      });
      words = addWords(words, child.wordCount, `frame child slot ${slot}`);
    }
    visiting.delete(owner);
    const layout: WgslFrameTemplateLayout = {
      id: semanticFrame.id,
      owner,
      ownerName: owner?.name ?? '<program>',
      committedActivationWordOffset: 0,
      tentativeActivationWordOffset: 1,
      activationEncoding: 'absolute-row-plus-one',
      locals,
      children,
      wordCount: words,
    };
    layouts.set(owner, layout);
    return layout;
  };
  const root = build(null);
  funcs.forEach(build);
  const templates = owners.map(
    owner => layouts.get(owner) ?? fatal('missing WGSL frame template'),
  );
  const templateByFunc = new Map<IrFunc, WgslFrameTemplateLayout>();
  templates.forEach(template => {
    if (template.owner !== null) templateByFunc.set(template.owner, template);
  });
  const localByName = new Map<Name, WgslFrameLocalLayout>();
  templates.forEach(template =>
    template.locals.forEach(local => {
      if (localByName.has(local.name)) {
        fatal(`WGSL name '${local.name.name}' belongs to two frame templates`);
      }
      localByName.set(local.name, local);
    }),
  );
  return {
    templates,
    root,
    templateByFunc,
    localByName,
    ephemeralFormalsByFunc,
  };
}
