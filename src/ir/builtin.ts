// Purpose: Shared closed identifiers for runtime-bound Tea builtins; this file defines names only and owns no semantic, Program, or runtime objects.

// Numeric data columns are selected by host id. The catalog owns the closed
// source-facing vocabulary; this alias keeps its projected carrier explicit.
export type DataSeriesId = string;

// A typed builtin supplied by the runtime context rather than the numeric
// data-series plane. `domain` is only a stable namespace for builtin identity;
// it does not imply a domain-shaped compiler or runtime object.
export type BuiltinSource =
  | {
      readonly domain: 'time';
      readonly field: 'time' | 'time_close' | 'timenow';
    }
  | {
      readonly domain: 'bar';
      readonly field: 'bar_index' | 'last_bar_index';
    }
  | {
      readonly domain: 'barstate';
      readonly field:
        | 'isfirst'
        | 'islast'
        | 'ishistory'
        | 'isrealtime'
        | 'isconfirmed'
        | 'isnew';
    }
  | {
      readonly domain: 'syminfo';
      readonly field:
        | 'tickerid'
        | 'ticker'
        | 'prefix'
        | 'currency'
        | 'basecurrency'
        | 'type'
        | 'timezone'
        | 'mintick'
        | 'pointvalue';
    }
  | {
      readonly domain: 'timeframe';
      readonly field:
        | 'period'
        | 'multiplier'
        | 'isseconds'
        | 'isminutes'
        | 'isintraday'
        | 'isdaily'
        | 'isweekly'
        | 'ismonthly'
        | 'isdwm';
    };
