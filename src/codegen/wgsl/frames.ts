// Purpose: Deterministic static call-site frame projection for WGSL state.

import {fatal} from '../../base/print';
import {
  DepthKind,
  IrKind,
  PlaceKind,
  type IrExpr,
  type IrStmt,
  type Name,
} from '../../ir/node';
import {TypeKind} from '../../ir/type';
import type {IrFunc, Program} from '../../ir/program';
import {funcsOf, namesOf} from '../../ir/visit';

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
  const funcs = funcsOf(program);
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
  program.init.forEach(stmt => walkStmt(stmt, noteHistoryDemand));
  program.body.forEach(stmt => walkStmt(stmt, noteHistoryDemand));
  funcs.forEach(func => walkExpr(func.body, noteHistoryDemand));
  const functionNames = new Set<Name>();
  funcs.forEach(func => {
    if (func.callMode !== 'free') functionNames.add(func.receiver);
    func.params.forEach(name => functionNames.add(name));
    func.locals.forEach(name => functionNames.add(name));
  });
  const packageGlobals = new Set(program.packageGlobals);
  const rootNames = [
    ...program.packageGlobals,
    ...namesOf(program).filter(
      name => !functionNames.has(name) && !packageGlobals.has(name),
    ),
  ];
  const owners: Array<IrFunc | null> = [null, ...funcs];
  const ownerIds = new Map<IrFunc | null, number>(
    owners.map((owner, id) => [owner, id]),
  );
  const directChildren = new Map<IrFunc | null, Map<number, IrFunc>>();
  owners.forEach(owner => {
    const children = new Map<number, IrFunc>();
    const note = (expr: IrExpr): void => {
      if (
        expr.kind !== IrKind.CallFunc &&
        expr.kind !== IrKind.CallConstMethod &&
        expr.kind !== IrKind.CallMutableMethod
      ) {
        return;
      }
      const existing = children.get(expr.slot);
      if (existing !== undefined && existing !== expr.func) {
        throw new WgslFrameProjectionError(
          `frame slot ${expr.slot} has two callees`,
        );
      }
      children.set(expr.slot, expr.func);
    };
    if (owner === null) {
      program.body.forEach(stmt => walkStmt(stmt, note));
    } else {
      walkExpr(owner.body, note);
    }
    directChildren.set(owner, children);
  });

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
      names = rootNames;
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
    for (const [slot, callee] of [...(directChildren.get(owner) ?? [])].sort(
      ([left], [right]) => left - right,
    )) {
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
    const id = ownerIds.get(owner);
    if (id === undefined) return fatal('unmapped WGSL frame owner');
    const layout: WgslFrameTemplateLayout = {
      id,
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

function walkStmt(stmt: IrStmt, visit: (expr: IrExpr) => void): void {
  switch (stmt.kind) {
    case IrKind.ExprStmt:
      walkExpr(stmt.x, visit);
      return;
    case IrKind.InitName:
    case IrKind.WriteName:
      walkExpr(stmt.value, visit);
      return;
    case IrKind.UpdateValuePath:
      walkExpr(stmt.value, visit);
      return;
    case IrKind.Emit:
      stmt.args.forEach(arg => walkExpr(arg, visit));
      return;
    case IrKind.EmitEffect:
      walkExpr(stmt.payload, visit);
      return;
    case IrKind.Break:
    case IrKind.Continue:
      return;
    default:
      return unreachableStmt(stmt);
  }
}

function walkExpr(expr: IrExpr, visit: (expr: IrExpr) => void): void {
  visit(expr);
  const child = (nested: IrExpr): void => walkExpr(nested, visit);
  switch (expr.kind) {
    case IrKind.Const:
    case IrKind.OutputRef:
      return;
    case IrKind.HistRead:
      if (expr.offset !== null) child(expr.offset);
      return;
    case IrKind.Binary:
      child(expr.x);
      child(expr.y);
      return;
    case IrKind.Unary:
      child(expr.x);
      return;
    case IrKind.Cond:
      child(expr.cond);
      child(expr.then);
      child(expr.else);
      return;
    case IrKind.CallFunc:
    case IrKind.CallNative:
      expr.args.forEach(child);
      return;
    case IrKind.CallConstMethod:
    case IrKind.CallMutableMethod:
      child(expr.receiver);
      expr.args.forEach(child);
      return;
    case IrKind.MutateCollection:
      child(expr.receiver);
      expr.args.forEach(child);
      return;
    case IrKind.NewUserValue:
      expr.args.forEach(child);
      return;
    case IrKind.MakeTuple:
      expr.elems.forEach(child);
      return;
    case IrKind.TupleGet:
    case IrKind.FieldGet:
      child(expr.x);
      return;
    case IrKind.IfExpr:
      child(expr.cond);
      child(expr.then);
      if (expr.else !== null) child(expr.else);
      return;
    case IrKind.SwitchExpr:
      if (expr.subject !== null) child(expr.subject);
      expr.arms.forEach(arm => {
        if (arm.pattern !== null) child(arm.pattern);
        child(arm.body);
      });
      return;
    case IrKind.ForExpr:
      child(expr.from);
      child(expr.to);
      if (expr.step !== null) child(expr.step);
      child(expr.body);
      return;
    case IrKind.ForInExpr:
      child(expr.x);
      child(expr.body);
      return;
    case IrKind.WhileExpr:
      child(expr.cond);
      child(expr.body);
      return;
    case IrKind.BlockExpr:
      expr.stmts.forEach(stmt => walkStmt(stmt, visit));
      if (expr.value !== null) child(expr.value);
      return;
    default:
      return unreachableExpr(expr);
  }
}

function unreachableExpr(expr: never): never {
  return fatal(`unhandled WGSL frame expression ${JSON.stringify(expr)}`);
}

function unreachableStmt(stmt: never): never {
  return fatal(`unhandled WGSL frame statement ${JSON.stringify(stmt)}`);
}
