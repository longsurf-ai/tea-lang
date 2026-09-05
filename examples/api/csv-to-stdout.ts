import {fromCSV, StdoutSink, tea} from 'tea';
import {Field, Float64, Schema} from 'apache-arrow';

const inputPath = process.argv[2];
if (inputPath === undefined) {
  throw new Error('usage: node examples/api/csv-to-stdout.ts INPUT');
}

const schema = new Schema([new Field('close', new Float64(), false)]);
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
