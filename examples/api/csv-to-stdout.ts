import {pathToFileURL} from 'node:url';
import type {Subscription} from 'rxjs';
import {fromCSV, StdoutSink, tea} from 'tea';
import * as z from 'zod';

const row = z.object({close: z.coerce.number()});

export async function run(
  input: string,
  writeLine = console.log,
): Promise<Subscription> {
  const node = tea`
    threshold = input.float(1.5, "Threshold")
    adjusted = 0.0
    if close > threshold
        adjusted := close * 2
    else
        adjusted := 0 - close

    plot(adjusted, "Adjusted close")
  `;
  node.bind({threshold: 1.5});
  node.bind(await fromCSV(input, row));
  return node.to(new StdoutSink(undefined, writeLine));
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const input = process.argv[2];
  if (input === undefined) {
    throw new Error('usage: tsx examples/api/csv-to-stdout.ts INPUT');
  }
  await run(input);
}
