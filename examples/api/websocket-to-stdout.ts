import {fromWS, StdoutSink, tea} from 'tea';
import {Field, Float64, Schema} from 'apache-arrow';

const url = process.argv[2];
if (url === undefined) {
  throw new Error('usage: node examples/api/websocket-to-stdout.ts URL');
}

const schema = new Schema([new Field('close', new Float64(), false)]);
const source = fromWS(url, schema);

let node = tea`
  threshold = input.float(100.0, "Threshold")
  var float balance = 0.0
  if close >= threshold
      balance := balance + close
  else
      balance := balance - close

  plot("Signed running balance", balance, "Signed running balance")
  plot("Above threshold", close >= threshold ? 1 : 0, "Above threshold")
`;

node = node.bind(source);
node = node.bind({threshold: 100});

const stdout = new StdoutSink();
node.to(stdout);
