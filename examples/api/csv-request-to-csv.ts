import {CSVSink, fromCSV, tea} from 'tea';
import {Field, Float64, Schema} from 'apache-arrow';

const mainPath = process.argv[2];
const requestPath = process.argv[3];
const outputPath = process.argv[4];
if (
  mainPath === undefined ||
  requestPath === undefined ||
  outputPath === undefined
) {
  throw new Error(
    'usage: node examples/api/csv-request-to-csv.ts MAIN REQUEST OUTPUT',
  );
}

const schema = new Schema([new Field('close', new Float64(), false)]);
const main = await fromCSV(mainPath, schema);
const requested = await fromCSV(requestPath, schema);

const node = tea`
  requested = request.security("child", "", close)
  var float spreadBalance = 0.0
  if close > requested
      spreadBalance := spreadBalance + close - requested
  else if close < requested
      spreadBalance := spreadBalance - requested + close

  plot("Cumulative spread", spreadBalance, "Cumulative spread")
  plot("Combined value", close + requested, "Combined value")
`;

node.bind({close: main, requested});

const csv = new CSVSink(outputPath, 'w');
node.to(csv);

await csv.completion;
