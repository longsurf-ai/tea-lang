import {CSVSink, fromCSV, tea} from 'tea';
import {Field, Float64, Schema} from 'apache-arrow';

const inputPath = process.argv[2];
const outputPath = process.argv[3];
if (inputPath === undefined || outputPath === undefined) {
  throw new Error('usage: node examples/api/csv-to-csv.ts INPUT OUTPUT');
}

const schema = new Schema([new Field('close', new Float64(), false)]);
const source = await fromCSV(inputPath, schema);

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

node.bind(source);
node.bind({threshold: 1.5});

const csv = new CSVSink(outputPath, 'w');
node.to(csv);

await csv.completion;
