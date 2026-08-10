// Purpose: Per-semantic-context syntax facts and resolved calls produced by the checker and consumed by noding.

import type {Qualifier, Type, TypeAndValue} from '../ir/type';
import type * as syntax from '../syntax/nodes';
import type {NativeFunc} from './catalog';
import type {
  BuiltinObject,
  FieldObject,
  FunctionObject,
  Object,
  UdtObject,
  VariableObject,
} from './object';
import type {Scope} from './scope';

export const CallKind = {
  Native: 'native',
  Function: 'function',
  Constructor: 'constructor',
  Request: 'request',
} as const;

export interface CheckedExpression {
  readonly expr: syntax.Expr;
  readonly info: Info;
  readonly tv: TypeAndValue;
}

export type SemanticDependency = BuiltinObject | VariableObject;

export interface CheckedDefaultExpression extends CheckedExpression {
  readonly dependencies: ReadonlySet<SemanticDependency>;
}

export interface NativeCall {
  readonly kind: typeof CallKind.Native;
  readonly native: NativeFunc;
  readonly args: readonly (syntax.Expr | null)[];
}

export interface FunctionCall {
  readonly kind: typeof CallKind.Function;
  readonly instance: FunctionInstance;
  readonly args: readonly (syntax.Expr | null)[];
}

export interface ConstructorArgument {
  readonly field: FieldObject;
  readonly value: CheckedExpression;
  readonly supplied: boolean;
}

export interface ConstructorCall {
  readonly kind: typeof CallKind.Constructor;
  readonly type: UdtObject;
  readonly args: readonly ConstructorArgument[];
}

export interface RequestCall {
  readonly kind: typeof CallKind.Request;
  readonly native: NativeFunc;
  readonly args: readonly (syntax.Expr | null)[];
  readonly capture: Info;
  readonly resultType: Type;
}

export type CallResolution =
  | NativeCall
  | FunctionCall
  | ConstructorCall
  | RequestCall;

export const SelectionKind = {
  Field: 'field',
  Builtin: 'builtin',
} as const;

export type Selection =
  | {readonly kind: typeof SelectionKind.Field; readonly field: FieldObject}
  | {
      readonly kind: typeof SelectionKind.Builtin;
      readonly builtin: BuiltinObject;
    };

export interface Info {
  readonly types: Map<syntax.Expr, TypeAndValue>;
  readonly uses: Map<syntax.Name, Object>;
  readonly defs: Map<syntax.Name, Object>;
  readonly reassigned: Set<VariableObject>;
  readonly calls: Map<syntax.CallExpr, CallResolution>;
  readonly selections: Map<syntax.SelectorExpr, Selection>;
  readonly scopes: Map<syntax.Node, Scope>;
}

export function newInfo(): Info {
  return {
    types: new Map(),
    uses: new Map(),
    defs: new Map(),
    reassigned: new Set(),
    calls: new Map(),
    selections: new Map(),
    scopes: new Map(),
  };
}

export interface FunctionInstance {
  readonly template: FunctionObject;
  readonly name: string;
  readonly signature: readonly ({
    readonly type: Type;
    readonly qualifier: Qualifier;
  } | null)[];
  readonly params: readonly VariableObject[];
  readonly defaults: ReadonlyMap<number, CheckedDefaultExpression>;
  readonly info: Info;
  // Exact non-local semantic dependencies. Builtins reproject into each
  // Program; outer variables are checked against request capture policy.
  readonly dependencies: Set<SemanticDependency>;
  resultType: Type;
  resultQualifier: Qualifier;
}
