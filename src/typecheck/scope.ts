// Purpose: Lexical scopes for the checker — the binder. Declaration sites create ir Name objects directly; the binder's objects ARE the IR Names, one object set from binding through codegen.

import type {Name as IrName} from '../ir/node';
import type {ConstValue, EnumType, UdtType} from '../ir/type';
import type {FuncDecl} from '../syntax/nodes';

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
} as const;

export type ScopeEntry =
  | {
      readonly kind: typeof EntryKind.Name;
      readonly name: IrName;
      readonly constDecl: boolean;
      readonly constValue: ConstValue | null;
    }
  | {readonly kind: typeof EntryKind.Func; readonly decl: FuncDecl}
  | {readonly kind: typeof EntryKind.Udt; readonly type: UdtType}
  | {readonly kind: typeof EntryKind.Enum; readonly type: EnumType};

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
