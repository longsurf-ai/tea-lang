// TypeScript checks the emitted program against the actual runtime library.

import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {fatal} from '../base/print';

/**
 * Check one generated TypeScript module using the installed TypeScript compiler.
 * Builds call this after lowering; tagged templates skip this slower validation.
 * A diagnostic is a compiler defect because the Tea frontend already accepted
 * the program. Runtime declarations resolve through the package's real exports.
 *
 * @example `checkGenerated(generate(program))` either returns or reports the
 * generated line and TypeScript diagnostic that the compiler must fix.
 */
export function checkGenerated(source: string): void {
  const filename = fileURLToPath(
    new URL('../../generated.ts', import.meta.resolve('tea/runtime')),
  );
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (
    path,
    languageVersion,
    onError,
    shouldCreateNewSourceFile,
  ) =>
    path === filename
      ? ts.createSourceFile(path, source, languageVersion, true)
      : read(path, languageVersion, onError, shouldCreateNewSourceFile);
  const diagnostics = ts.getPreEmitDiagnostics(
    ts.createProgram([filename], options, host),
  );
  if (diagnostics.length) {
    fatal(
      `invalid generated TypeScript:\n${ts.formatDiagnostics(diagnostics, {
        getCanonicalFileName: path => path,
        getCurrentDirectory: host.getCurrentDirectory,
        getNewLine: () => '\n',
      })}`,
    );
  }
}
