// Purpose: Trace-format OutputSink — the single owner of the textual trace format shared by `tea run` and the run goldens; hosts inject only the line writer.

import type {OutputSink, Value} from '../runtime/abi';

function formatValue(v: Value): string {
  if (typeof v === 'number') {
    return Number.isNaN(v) ? 'na' : String(v);
  }
  return String(v);
}

// One line per declaration, then one line per emission:
//   # output[<oid>] <effect> <static args> bound{<bound args>}
//   <row> <oid>[ ?] <channel values>
export class TraceSink implements OutputSink {
  constructor(private readonly writeLine: (line: string) => void) {}

  declare(outputs: Parameters<OutputSink['declare']>[0]): void {
    outputs.forEach((output, oid) => {
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
  }

  emit(
    row: number,
    oid: number,
    channels: readonly Value[],
    provisional: boolean,
  ): void {
    this.writeLine(
      `${row} ${oid}${provisional ? ' ?' : ''} ${channels
        .map(formatValue)
        .join(' ')}`,
    );
  }
}
