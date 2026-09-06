import {Subject} from 'rxjs';
import {CSVSink, DataStream, StdoutSink, tea} from 'tea';
import {Field, Float64, Schema} from 'apache-arrow';

const input = new Subject<unknown>();
const schema = new Schema([new Field('close', new Float64(), false)]);
const source = new DataStream(schema, input);

const node = tea`
  var float total = 0.0
  total := total + close
  plot("output0", total)
`;

node.bind(source);

const stdout = new StdoutSink();
const csv = new CSVSink('tea-stream-output.csv');
node.to(stdout);
node.to(csv);

const prices = [8, 12, 15, 9, 10, 14];
let index = 0;

const timer = setInterval(() => {
  const close = prices[index++];

  if (close === undefined) {
    clearInterval(timer);
    input.complete();
    return;
  }

  console.log('input:', close);
  input.next({close});
}, 1000);

await csv.completion;
console.log(`wrote tea-stream-output.csv`);
