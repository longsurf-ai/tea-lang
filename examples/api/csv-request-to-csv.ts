import {pathToFileURL} from 'node:url';
import {CSVSink, fromCSV, tea} from 'tea';
import * as z from 'zod';

const row = z.object({close: z.coerce.number()});

export async function run(
  mainPath: string,
  requestPath: string,
  outputPath: string,
): Promise<void> {
  const node = tea`
    requested = request.security("child", "", close)
    var float spreadBalance = 0.0
    if close > requested
        spreadBalance := spreadBalance + close - requested
    else if close < requested
        spreadBalance := spreadBalance - requested + close

    plot(spreadBalance, "Cumulative spread")
    plot(close + requested, "Combined value")
  `;
  node.bind({
    close: await fromCSV(mainPath, row),
    requested: await fromCSV(requestPath, row),
  });
  const sink = new CSVSink(outputPath, 'w');
  node.to(sink);
  await sink.completion;
  node.dispose();
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [, , main, request, output] = process.argv;
  if (main === undefined || request === undefined || output === undefined) {
    throw new Error(
      'usage: tsx examples/api/csv-request-to-csv.ts MAIN REQUEST OUTPUT',
    );
  }
  await run(main, request, output);
}
