// Purpose: Test helpers for the typecheck package — parse and check a source string against a fresh Errors instance, and look up declared ir Names by source name.

import {Errors, fatal, type ErrorMsg} from '../base/print';
import {newFileBase} from '../base/pos';
import type {Name as IrName} from '../ir/node';
import type {TypeAndValue} from '../ir/type';
import {resolveImports} from '../loader/loader';
import {NodeKind, type File} from '../syntax/nodes';
import {parse} from '../syntax/syntax';
import {check, type Info} from './check';
import type {Importer} from './importer';

export interface CheckResult {
  readonly file: File;
  readonly info: Info;
  readonly errors: readonly ErrorMsg[];
}

export function checkText(
  src: string,
  filename = 'test.tea',
  importer?: Importer,
): CheckResult {
  const errors = new Errors();
  const file = parse(newFileBase(filename), src, (pos, msg) =>
    errors.errorAt(pos, msg),
  );
  const info = check(file, errors, importer ?? resolveImports([file]));
  return {file, info, errors: errors.flushErrors()};
}

// The ir Name created by the top-level declaration of `name`; fails the test
// run loudly when the fixture does not declare it.
export function declaredName(result: CheckResult, name: string): IrName {
  for (const stmt of result.file.stmtList) {
    if (stmt.kind !== NodeKind.DeclStmt) {
      continue;
    }
    if (stmt.target.kind === NodeKind.Name && stmt.target.value === name) {
      const irName = result.info.defs.get(stmt.target);
      if (irName !== undefined) {
        return irName;
      }
    }
    if (stmt.target.kind === NodeKind.TuplePattern) {
      for (const elem of stmt.target.elems) {
        if (elem.value === name) {
          const irName = result.info.defs.get(elem);
          if (irName !== undefined) {
            return irName;
          }
        }
      }
    }
  }
  return fatal(`fixture declares no name '${name}'`);
}

// The checked TypeAndValue of the top-level declaration initializer of
// `name` — the folding observation point.
export function initTvOf(result: CheckResult, name: string): TypeAndValue {
  for (const stmt of result.file.stmtList) {
    if (
      stmt.kind === NodeKind.DeclStmt &&
      stmt.target.kind === NodeKind.Name &&
      stmt.target.value === name
    ) {
      const tv = result.info.types.get(stmt.init);
      if (tv !== undefined) {
        return tv;
      }
    }
  }
  return fatal(`fixture declares no name '${name}'`);
}
