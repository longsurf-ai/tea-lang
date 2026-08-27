import {fromWS, tea, WebSocketSink} from 'tea';
import * as z from 'zod';

const inputURL = process.argv[2];
const outputURL = process.argv[3];
if (inputURL === undefined || outputURL === undefined) {
  throw new Error(
    'usage: node examples/api/websocket-to-websocket.ts INPUT_URL OUTPUT_URL',
  );
}

const inputSchema = z.object({close: z.number()});
const outputSchema = z.object({
  index: z.number().int().nonnegative(),
  time: z.number().int().nullable().optional(),
  outputs: z.array(
    z.object({
      outputId: z.number().int().nonnegative(),
      channels: z.array(z.unknown()).readonly(),
    }),
  ).readonly(),
  effects: z.array(
    z.object({
      effectId: z.number().int().nonnegative(),
      payload: z.unknown(),
    }),
  ).readonly(),
  provisional: z.boolean(),
});
const source = fromWS(inputURL, inputSchema);

const node = tea`
  var float peak = na
  if na(peak) or close > peak
      peak := close

  plot(peak, "Peak")
  plot(close - peak, "Drawdown")
`;

node.bind(source);

const websocket = new WebSocketSink(outputURL, outputSchema);
node.to(websocket);

await websocket.completion;
