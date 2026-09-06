// Purpose: Per-semantic-context syntax facts and resolved calls produced by the checker and consumed by noding.

import type {ConstValue, Qualifier, Type, TypeAndValue} from '../ir/type';
import type {Pos} from '../base/pos';
import type * as syntax from '../syntax/nodes';
import type {NativeFunc} from './catalog';
import type {
  BuiltinObject,
  FieldObject,
  FunctionObject,
  Object,
  StructObject,
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

/** A statically named column shared by reachable writes in one compilation. */
export interface OutputColumn {
  readonly name: string;
  readonly mode: 'set' | 'append';
  readonly valueType: Type;
  readonly pos: Pos;
}

export interface CheckedDefaultExpression extends CheckedExpression {
  readonly dependencies: ReadonlySet<SemanticDependency>;
}

export interface NativeCall {
  readonly kind: typeof CallKind.Native;
  readonly native: NativeFunc;
  readonly args: readonly (syntax.Expr | null)[];
  readonly argTypes: readonly Type[];
  // Canonical argument indices in source evaluation order. Omitted runtime
  // defaults are absent and therefore have no source evaluation position.
  readonly argumentEvaluationOrder: readonly number[];
  readonly resultType: Type;
  readonly receiver: NativeReceiver | null;
}

export interface FunctionCall {
  readonly kind: typeof CallKind.Function;
  readonly instance: FunctionInstance;
  readonly args: readonly (syntax.Expr | null)[];
  // Covers explicit source parameters only: supplied arguments in source
  // order, then omitted user defaults in canonical parameter order. A method
  // receiver is a separate semantic input evaluated before these arguments.
  readonly argumentEvaluationOrder: readonly number[];
  readonly receiver: MethodReceiver | null;
}

export interface ConstructorArgument {
  readonly field: FieldObject;
  readonly value: CheckedExpression;
  readonly supplied: boolean;
}

export interface ConstructorCall {
  readonly kind: typeof CallKind.Constructor;
  readonly type: StructObject;
  readonly args: readonly ConstructorArgument[];
  // Supplied arguments retain source order; omitted field defaults follow in
  // canonical field order. `args` itself remains canonical for struct layout.
  readonly argumentEvaluationOrder: readonly number[];
}

export interface RequestCall {
  readonly kind: typeof CallKind.Request;
  readonly native: NativeFunc;
  readonly bindingName: string;
  readonly args: readonly (syntax.Expr | null)[];
  readonly argumentEvaluationOrder: readonly number[];
  readonly capture: Info;
  readonly captureType: Type;
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

export interface StructFieldStore {
  // The expression producing the StructRef whose direct field is written.
  // Noding evaluates and captures it once before evaluating the replacement.
  readonly object: CheckedExpression;
  readonly owner: StructObject;
  readonly field: FieldObject;
}

export type CollectionLocation =
  | {
      readonly kind: 'name';
      readonly name: VariableObject;
    }
  | ({readonly kind: 'structField'} & StructFieldStore);

export type NativeReceiver =
  | {
      readonly mode: 'value';
      readonly value: CheckedExpression;
    }
  | {
      readonly mode: 'inout';
      readonly value: CheckedExpression;
      readonly location: CollectionLocation;
    };

export type MethodReceiver =
  | {
      readonly mode: 'const';
      readonly value: CheckedExpression;
    }
  | {
      readonly mode: 'mutable';
      readonly value: CheckedExpression;
    };

export interface Info {
  readonly emits: Map<syntax.EmitStmt, OutputColumn>;
  readonly returns: Map<syntax.ReturnStmt, TypeAndValue>;
  readonly types: Map<syntax.Expr, TypeAndValue>;
  readonly uses: Map<syntax.Name | syntax.ThisExpr, Object>;
  readonly defs: Map<syntax.Name, Object>;
  readonly reassigned: Set<VariableObject>;
  readonly calls: Map<syntax.CallExpr, CallResolution>;
  readonly updates: Map<syntax.AssignStmt, StructFieldStore>;
  readonly selections: Map<syntax.SelectorExpr, Selection>;
  readonly scopes: Map<syntax.Node, Scope>;
  // Library-root runtime global initializers, keyed by their canonical
  // objects. Noder consumes the owning package's Info instead of rechecking.
  readonly packageGlobalInitializers: Map<
    VariableObject,
    CheckedDefaultExpression
  >;
}

export function newInfo(): Info {
  return {
    emits: new Map(),
    returns: new Map(),
    types: new Map(),
    uses: new Map(),
    defs: new Map(),
    reassigned: new Set(),
    calls: new Map(),
    updates: new Map(),
    selections: new Map(),
    scopes: new Map(),
    packageGlobalInitializers: new Map(),
  };
}

export interface FunctionInstance {
  readonly template: FunctionObject;
  readonly name: string;
  readonly signature: readonly ({
    readonly type: Type;
    readonly qualifier: Qualifier;
    readonly value: ConstValue | null;
  } | null)[];
  // Compiler-only method receiver. It is not a source parameter and therefore
  // never appears in signature/params/defaults or call argument ordering.
  readonly receiver: VariableObject | null;
  readonly params: readonly VariableObject[];
  readonly defaults: ReadonlyMap<number, CheckedDefaultExpression>;
  readonly info: Info;
  // Exact non-local semantic dependencies. Builtins reproject into each
  // Program; outer variables are checked against request capture policy.
  readonly dependencies: Set<SemanticDependency>;
  resultType: Type;
  resultQualifier: Qualifier;
}
