import {expect, test} from 'vitest';
import {OperationalError} from '../base/operational-error';
import {cliFailure} from './result';

test('only operational errors become CLI failures', () => {
  expect(cliFailure(new OperationalError('bad input'))).toEqual({
    ok: false,
    kind: 'failure',
    message: 'bad input',
  });
  expect(cliFailure(new Error('bug'))).toBeNull();
});
