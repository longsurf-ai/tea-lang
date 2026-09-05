// Purpose: Final-only JSON WebSocket source/sink lifecycle without network I/O.

import {firstValueFrom, toArray} from 'rxjs';
import {beforeEach, describe, expect, test} from 'vitest';
import {Field, Float64, Schema} from 'apache-arrow';
import {WebSocketSink} from './sink';
import {WebSocketSource} from './source';

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readyState = FakeWebSocket.CONNECTING;
  bufferedAmount = 0;

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  message(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', {data}));
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(Object.assign(new Event('close'), {wasClean: true}));
  }
}

const Socket = FakeWebSocket as unknown as typeof WebSocket;
const schema = new Schema([new Field('close', new Float64(), false)]);

beforeEach(() => {
  FakeWebSocket.instances.splice(0);
});

describe('WebSocketSource', () => {
  test('connects lazily, parses JSON, and completes on clean close', async () => {
    const source = new WebSocketSource(
      'ws://source',
      schema,
      undefined,
      Socket,
    );
    const stream = source.stream();
    expect(FakeWebSocket.instances).toEqual([]);
    const values = firstValueFrom(stream.asObservable().pipe(toArray()));
    const socket = FakeWebSocket.instances[0]!;

    socket.open();
    socket.message('{"close":1}');
    socket.message('{"close":2}');
    socket.close();

    await expect(values).resolves.toEqual([{close: 1}, {close: 2}]);
  });

  test('rejects a decoded value that violates the Arrow field type', async () => {
    const stream = new WebSocketSource(
      'ws://source',
      schema,
      undefined,
      Socket,
    ).stream();
    const result = firstValueFrom(stream.asObservable());
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.message('{"close":"bad"}');
    await expect(result).rejects.toBeInstanceOf(TypeError);
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  });

  test('fails malformed JSON and closes on unsubscribe', async () => {
    const stream = new WebSocketSource(
      'ws://source',
      schema,
      undefined,
      Socket,
    ).stream();
    const error = firstValueFrom(stream.asObservable());
    const socket = FakeWebSocket.instances[0]!;

    socket.open();
    socket.message('not json');
    await expect(error).rejects.toBeInstanceOf(SyntaxError);
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);

    const subscription = stream.subscribe({next() {}});
    const second = FakeWebSocket.instances[1]!;
    subscription.unsubscribe();
    expect(second.readyState).toBe(FakeWebSocket.CLOSED);
  });
});

describe('WebSocketSink', () => {
  test('queues until open, sends validated JSON, and closes on completion', async () => {
    const sink = new WebSocketSink(
      'ws://sink',
      schema,
      4,
      'error',
      1024,
      Socket,
    );
    const socket = FakeWebSocket.instances[0]!;

    sink.write({close: 1});
    expect(socket.sent).toEqual([]);
    socket.open();
    expect(socket.sent).toEqual(['{"close":1}']);
    sink.complete();

    await sink.completion;
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  });

  test('isolates schema mutations and rejects invalid values before sending', async () => {
    const schema = new Schema([new Field('close', new Float64(), false)]);
    const sink = new WebSocketSink(
      'ws://sink',
      schema,
      4,
      'error',
      1024,
      Socket,
    );
    schema.fields.splice(0);
    sink.schema.fields.splice(0);
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    sink.write({close: 'bad'});
    await expect(sink.completion).rejects.toBeInstanceOf(TypeError);
    expect(socket.sent).toEqual([]);
  });

  test('fails closed when its bounded queue overflows', async () => {
    const sink = new WebSocketSink(
      'ws://sink',
      schema,
      1,
      'error',
      1024,
      Socket,
    );

    sink.write({close: 1});
    sink.write({close: 2});

    await expect(sink.completion).rejects.toThrow('exceeded capacity 1');
  });

  test('drop-oldest retains the newest pending message', async () => {
    const sink = new WebSocketSink(
      'ws://sink',
      schema,
      1,
      'drop-oldest',
      1024,
      Socket,
    );
    const socket = FakeWebSocket.instances[0]!;

    sink.write({close: 1});
    sink.write({close: 2});
    socket.open();
    sink.complete();

    await sink.completion;
    expect(socket.sent).toEqual(['{"close":2}']);
  });
});
