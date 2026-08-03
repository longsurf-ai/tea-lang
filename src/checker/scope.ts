// Purpose: Lexical scopes for the checker — the binder. Declaration sites create ir Name objects directly; the binder's objects ARE the IR Names, one object set from binding through codegen.

import type {Name as IrName} from '../ir/node';
import type {ConstValue, EnumType, UdtType} from '../ir/type';
import type {FuncDecl} from '../syntax/nodes';
import type {BuiltinLibrary} from './library';

// What an identifier resolves to. Name is a variable backed by an ir Name;
// constDecl marks Tea's `const` declaration mode (reassignment forbidden,
// folded value recorded). Func is an uninstantiated user-function template
// (stenciled per signature when calls are checked). Udt/Enum are type
// declarations.
export const EntryKind = {
  Name: 'name',
  Func: 'func',
  Udt: 'udt',
  Enum: 'enum',
  Library: 'library',
} as const;

export type ScopeEntry =
  | {
      readonly kind: typeof EntryKind.Name;
      readonly name: IrName;
      readonly constDecl: boolean;
      readonly constValue: ConstValue | null;
    }
  | {
      readonly kind: typeof EntryKind.Func;
      readonly decl: FuncDecl;
      // The scope the template's body resolves against when instantiated:
      // the user file's global scope, or the prelude scope for ta.*.
      readonly base: Scope;
    }
  | {readonly kind: typeof EntryKind.Udt; readonly type: UdtType}
  | {readonly kind: typeof EntryKind.Enum; readonly type: EnumType}
  // An imported library namespace (builtin libraries bind implicitly).
  | {
      readonly kind: typeof EntryKind.Library;
      readonly library: BuiltinLibrary;
    };

export class Scope {
  private readonly entries = new Map<string, ScopeEntry>();

  constructor(readonly parent: Scope | null) {}

  lookup(name: string): ScopeEntry | null {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let scope: Scope | null = this;
    while (scope !== null) {
      const entry = scope.entries.get(name);
      if (entry !== undefined) {
        return entry;
      }
      scope = scope.parent;
    }
    return null;
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  // True when `name` resolves within the chain from this scope up to and
  // including `boundary` — how the checker decides a write target is local
  // to the current function instantiation.
  resolvesWithin(name: string, boundary: Scope): boolean {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let scope: Scope | null = this;
    while (scope !== null) {
      if (scope.has(name)) {
        return true;
      }
      if (scope === boundary) {
        return false;
      }
      scope = scope.parent;
    }
    return false;
  }

  // Declares into THIS scope; false when the name is already declared here
  // (shadowing an outer scope's name is allowed, redeclaring locally is not).
  declare(name: string, entry: ScopeEntry): boolean {
    if (this.entries.has(name)) {
      return false;
    }
    this.entries.set(name, entry);
    return true;
  }
}
