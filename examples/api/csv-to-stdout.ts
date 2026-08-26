import {fromCSV, StdoutSink, tea} from 'tea';
import * as z from 'zod';

const inputPath = process.argv[2];
if (inputPath === undefined) {
  throw new Error('usage: node examples/api/csv-to-stdout.ts INPUT');
}

const schema = z.object({close: z.coerce.number()});
const source = await fromCSV(inputPath, schema);

const node = tea`
  threshold = input.float(1.5, "Threshold")
  adjusted = 0.0
  if close > threshold
      adjusted := close * 2
  else
      adjusted := 0 - close

  plot(adjusted, "Adjusted close")
`;

node.bind(source);
node.bind({threshold: 1.5});

const stdout = new StdoutSink();
node.to(stdout);
