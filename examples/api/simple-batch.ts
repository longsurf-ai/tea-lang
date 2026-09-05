import {from} from 'rxjs';
import {batchRecipe, DataStream, StdoutSink, tea, type Datum} from 'tea';
import {Field, Float64, Schema} from 'apache-arrow';

const node = tea`
gain = input.float(2.0)
plot(close * gain)
`;
const prices = new DataStream(
  new Schema([new Field('close', new Float64(), false)]),
  from([{close: 10}, {close: 12}, {close: 15}]),
);
const output = new StdoutSink<Datum>();

const result = await batchRecipe(node, [{gain: 2}, prices], output).execute();

console.log(`processed ${result.indices} data positions`);
