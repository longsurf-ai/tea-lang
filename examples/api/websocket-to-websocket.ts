import {pathToFileURL} from 'node:url';
import {fromWS, tea, WebSocketSink} from 'tea';
import * as z from 'zod';

const input = z.object({close: z.number()});
const output = z.object({
  output_0: z.number().nullable(),
  output_1: z.number().nullable(),
  effects: z.array(z.unknown()),
  provisional: z.boolean(),
});

export async function run(sourceURL: string, sinkURL: string): Promise<void> {
  const node = tea`
    var float peak = na
    if na(peak) or close > peak
        peak := close

    plot(peak, "Peak")
    plot(close - peak, "Drawdown")
  `;
  node.bind(fromWS(sourceURL, input));
  const sink = new WebSocketSink(sinkURL, output);
  node.to(sink);
  await sink.completion;
  node.dispose();
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [, , source, sink] = process.argv;
  if (source === undefined || sink === undefined) {
    throw new Error(
      'usage: tsx examples/api/websocket-to-websocket.ts SOURCE_URL SINK_URL',
    );
  }
  await run(source, sink);
}
