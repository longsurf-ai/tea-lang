import {fromWS, tea, WebSocketSink} from 'tea';
import {Field, Float64, Schema} from 'apache-arrow';

const inputURL = process.argv[2];
const outputURL = process.argv[3];
if (inputURL === undefined || outputURL === undefined) {
  throw new Error(
    'usage: node examples/api/websocket-to-websocket.ts INPUT_URL OUTPUT_URL',
  );
}

const inputSchema = new Schema([new Field('close', new Float64(), false)]);
const source = fromWS(inputURL, inputSchema);

const node = tea`
  var float peak = na
  if na(peak) or close > peak
      peak := close

  plot(peak, "Peak")
  plot(close - peak, "Drawdown")
`;

node.bind(source);

const websocket = new WebSocketSink(outputURL, node.module.outputs);
node.to(websocket);

await websocket.completion;
