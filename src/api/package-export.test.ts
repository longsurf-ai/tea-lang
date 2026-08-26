// Purpose: The installed package root exposes the public JavaScript API.

import {expect, test} from 'vitest';

test('package root exports the API barrel', async () => {
  const api = await import('tea');

  expect(typeof api.tea).toBe('function');
  expect(typeof api.fromCSV).toBe('function');
  expect(typeof api.CSVSink).toBe('function');
});
