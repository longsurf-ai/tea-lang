import {pathToFileURL} from 'node:url';
import {CSVSink, fromCSV, tea} from 'tea';
import * as z from 'zod';

const row = z.object({close: z.coerce.number()});

export async function run(input: string, output: string): Promise<void> {
  const node = tea`
    threshold = input.float(1.5, "Threshold")
    var float balance = 0.0
    if close >= threshold
        balance := balance + close
    else
        balance := balance - close

    plot(balance, "Signed running balance")
    plot(close >= threshold ? 1 : 0, "Above threshold")
  `;
  node.bind({threshold: 1.5});
  node.bind(await fromCSV(input, row));
  const sink = new CSVSink(output, 'w');
  node.to(sink);
  await sink.completion;
  node.dispose();
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [, , input, output] = process.argv;
  if (input === undefined || output === undefined) {
    throw new Error('usage: tsx examples/api/csv-to-csv.ts INPUT OUTPUT');
  }
  await run(input, output);
}
