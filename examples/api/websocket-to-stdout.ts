import {pathToFileURL} from 'node:url';
import type {Subscription} from 'rxjs';
import {fromWS, StdoutSink, tea} from 'tea';
import * as z from 'zod';

const row = z.object({close: z.number()});

export function run(url: string, writeLine = console.log): Subscription {
  const node = tea`
    threshold = input.float(100.0, "Threshold")
    var float balance = 0.0
    if close >= threshold
        balance := balance + close
    else
        balance := balance - close

    plot(balance, "Signed running balance")
    plot(close >= threshold ? 1 : 0, "Above threshold")
  `;
  node.bind({threshold: 100});
  node.bind(fromWS(url, row));
  return node.to(new StdoutSink(undefined, writeLine));
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const url = process.argv[2];
  if (url === undefined) {
    throw new Error('usage: tsx examples/api/websocket-to-stdout.ts URL');
  }
  run(url);
}
