// Purpose: Logging tests — level gating, scope-prefix overrides, child scoping, field formatting, and timer events, all through the capture sink.

import {afterEach, describe, expect, test} from 'vitest';
import {
  captureSink,
  configureLog,
  log,
  logConfig,
  parseLogLevel,
  stderrSink,
} from './log';

const original = logConfig();
afterEach(() => configureLog(original));

describe('levels and scopes', () => {
  test('events below the configured level are dropped', () => {
    const {sink, events} = captureSink();
    configureLog({level: 'warn', sink});
    const logger = log.child('provider');
    logger.debug('quiet');
    logger.info('quiet');
    logger.warn('loud');
    logger.error('loud');
    expect(events.map(e => e.level)).toEqual(['warn', 'error']);
  });

  test('the longest matching scope prefix wins', () => {
    const {sink, events} = captureSink();
    configureLog({
      level: 'error',
      scopes: {provider: 'warn', 'provider.yahoo': 'debug'},
      sink,
    });
    log.child('provider').child('yahoo').debug('deep');
    log.child('provider').child('fred').debug('dropped');
    log.child('provider').child('fred').warn('kept');
    log.child('runtime').warn('dropped');
    expect(events.map(e => `${e.scope}:${e.level}`)).toEqual([
      'provider.yahoo:debug',
      'provider.fred:warn',
    ]);
  });

  test('child scopes join with dots and events carry fields', () => {
    const {sink, events} = captureSink();
    configureLog({level: 'debug', sink});
    log.child('compile').child('check').info('done', {files: 3});
    expect(events[0].scope).toBe('compile.check');
    expect(events[0].fields).toEqual({files: 3});
  });

  test('startTimer emits a debug event with elapsed ms', () => {
    const {sink, events} = captureSink();
    configureLog({level: 'debug', sink});
    const done = log.child('perf').startTimer('phase');
    done({phase: 'check'});
    expect(events[0].level).toBe('debug');
    expect(typeof events[0].fields['ms']).toBe('number');
    expect(events[0].fields['phase']).toBe('check');
  });
});

describe('rendering and parsing', () => {
  test('the stderr sink renders one line with key=value fields', () => {
    const lines: string[] = [];
    const sink = stderrSink(line => lines.push(line));
    sink.emit({
      time: 0,
      level: 'warn',
      scope: 'provider.fred',
      message: 'context unavailable',
      fields: {symbol: 'FRED:CPIAUCSL', error: 'unknownSource', rows: 60},
    });
    expect(lines).toEqual([
      '[warn] provider.fred: context unavailable ' +
        '(symbol=FRED:CPIAUCSL error=unknownSource rows=60)',
    ]);
  });

  test('parseLogLevel accepts the four names and rejects the rest', () => {
    expect(parseLogLevel('debug')).toBe('debug');
    expect(parseLogLevel('warn')).toBe('warn');
    expect(parseLogLevel('verbose')).toBeNull();
  });
});
