import {from} from 'rxjs';
import {DataStream, StdoutSink, tea} from 'tea';
import {Field, Float64, Schema} from 'apache-arrow';

let node = tea`
gain = input.float(1.5, "Gain")
threshold = input.float(10.0, "Threshold")

var float score = 0.0
if close > threshold
    score := score + (close - threshold) * gain
else if close < threshold
    score := score - (threshold - close)
else
    score := score

regime = close > threshold ? 1 : close < threshold ? -1 : 0
plot("Running score", score, "Running score")
plot("Regime", regime, "Regime")
`;

// create source from a fake observable
const data = from([
  {close: 8},
  {close: 12},
  {close: 15},
  {close: 9},
  {close: 10},
  {close: 14},
]);

// create a schema
const schema = new Schema([new Field('close', new Float64(), false)]);

// create a data stream
const source = new DataStream(schema, data);

// bind the data stream to the node
node = node.bind(source);

// bind parameters to the node
node = node.bind({gain: 1.5, threshold: 10});

// create a sink
const sink = new StdoutSink();

// Subscribing the sink starts execution.
node.to(sink);
