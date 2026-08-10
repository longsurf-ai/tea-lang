// Purpose: Test helpers for the checker — parse/check source and inspect canonical semantic declarations and expression facts.

import {Errors, fatal, type ErrorMsg} from '../base/print';
import {newFileBase} from '../base/pos';
import type {TypeAndValue} from '../ir/type';
import {resolveImports} from '../loader/loader';
import {NodeKind, type File} from '../syntax/nodes';
import {parse} from '../syntax/syntax';
import {checkPackage, type CheckedPackage, type Info} from './check';
import type {Importer} from './importer';
import {ObjectKind, type VariableObject} from './object';

export interface CheckResult {
  readonly file: File;
  readonly checked: CheckedPackage;
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
  const checked = checkPackage(
    [file],
    errors,
    importer ?? resolveImports([file]),
  );
  return {
    file,
    checked,
    info: checked.info,
    errors: errors.flushErrors(),
  };
}

// The semantic variable created by the top-level declaration of `name`;
// fails loudly when the fixture does not declare one.
export function declaredName(
  result: CheckResult,
  name: string,
): VariableObject {
  for (const stmt of result.file.stmtList) {
    if (stmt.kind !== NodeKind.DeclStmt) {
      continue;
    }
    if (stmt.target.kind === NodeKind.Name && stmt.target.value === name) {
      const object = result.info.defs.get(stmt.target);
      if (object?.kind === ObjectKind.Variable) {
        return object;
      }
    }
    if (stmt.target.kind === NodeKind.TuplePattern) {
      for (const elem of stmt.target.elems) {
        if (elem.value === name) {
          const object = result.info.defs.get(elem);
          if (object?.kind === ObjectKind.Variable) {
            return object;
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
