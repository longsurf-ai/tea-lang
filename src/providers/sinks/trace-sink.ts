// Purpose: Trace-format OutputSink — the single owner of the textual trace format shared by `tea run` and the run goldens; hosts inject only the line writer.

import type {
  EffectValue,
  OutputSink,
  RowPublication,
  Value,
} from '../../runtime/abi';

function formatValue(v: Value): string {
  if (typeof v === 'number') {
    return Number.isNaN(v) ? 'na' : String(v);
  }
  // Reference na is null — print it as the language value.
  return v === null ? 'na' : String(v);
}

function formatEffectValue(v: EffectValue): string {
  if (typeof v === 'number') {
    return Number.isNaN(v) ? 'na' : String(v);
  }
  if (v === null) {
    return 'na';
  }
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

// One line per declaration, then one line per emission:
//   # output[<oid>] <effect> <static args> bound{<bound args>}
//   <row> <oid>[ ?] <channel values>
export class TraceSink implements OutputSink {
  constructor(private readonly writeLine: (line: string) => void) {}

  declare(declaration: Parameters<OutputSink['declare']>[0]): void {
    declaration.outputs.forEach((output, oid) => {
      const statics = output.spec.staticArgs
        .map(a => `${a.name}=${formatValue(a.value)}`)
        .join(' ');
      const bounds = output.boundArgs
        .map(a => `${a.name}=${formatValue(a.value)}`)
        .join(' ');
      this.writeLine(
        `# output[${oid}] ${output.spec.effect}` +
          (statics.length > 0 ? ` ${statics}` : '') +
          (bounds.length > 0 ? ` bound{${bounds}}` : ''),
      );
    });
    declaration.effects.forEach((effect, effectId) => {
      const payload = effect.payload;
      const name =
        payload.kind === 'enum' || payload.kind === 'user-type'
          ? payload.typeId
          : payload.kind;
      this.writeLine(`# effect[${effectId}] type=${name}`);
    });
  }

  publish(publication: RowPublication): void {
    for (const output of publication.outputs) {
      this.writeLine(
        `${publication.row} ${output.outputId}${publication.provisional ? ' ?' : ''} ${output.channels
          .map(formatValue)
          .join(' ')}`,
      );
    }
    for (const effect of publication.effects) {
      this.writeLine(
        `${publication.row} effect[${effect.effectId}]${publication.provisional ? ' ?' : ''} ${formatEffectValue(effect.payload)}`,
      );
    }
  }
}
