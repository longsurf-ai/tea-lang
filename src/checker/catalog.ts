// Purpose: Native catalog — the single declaration surface for host primitives: signatures, qualifier caps, const-literal requirements, effect classes. A builtin is listed here only if it is inexpressible in Tea; all of ta.* is prelude code, never catalog.

import type {DataSeriesId, BuiltinSource} from '../ir/builtin';
import {
  BoolType,
  ColorType,
  FloatType,
  HlineType,
  IntType,
  NaType,
  NA_VALUE,
  PlotType,
  Qualifier,
  StringType,
  VoidType,
  type ConstValue,
  type Type,
} from '../ir/type';

// TypeRef.Num accepts anything assignable to float (int, float, na);
// overloads express result-type differences. StringConvertible is the
// observable scalar/enum/resource domain; aggregate host representations are
// deliberately not part of Tea semantics.
export const TypeRef = {
  Num: 'num',
  Any: 'any',
  Enum: 'enum',
  Nullable: 'nullable',
  StringConvertible: 'string-convertible',
} as const;

export interface NativeTypeParam {
  readonly name: string;
  readonly constraint: 'storable' | 'map-key' | 'effect-payload';
}

export interface TypeParamRef {
  readonly kind: 'type-param';
  readonly name: string;
}

export type GenericTypeRef =
  | TypeParamRef
  | {readonly kind: 'array'; readonly element: NativeTypeRef}
  | {readonly kind: 'matrix'; readonly element: NativeTypeRef}
  | {
      readonly kind: 'map';
      readonly key: NativeTypeRef;
      readonly value: NativeTypeRef;
    };

export type NativeTypeRef =
  | Type
  | typeof TypeRef.Num
  | typeof TypeRef.Any
  | typeof TypeRef.Enum
  | typeof TypeRef.Nullable
  | typeof TypeRef.StringConvertible
  | GenericTypeRef;

// A result whose nominal type is selected by the first argument. input.enum
// is the canonical case: every enum declaration is a distinct type, so the
// catalog cannot name one concrete result ahead of overload matching.
export const FirstArgumentResult = 'first-argument';
export type NativeResult = Type | GenericTypeRef | typeof FirstArgumentResult;

export type InputDisplay = 'all' | 'none' | 'data_window' | 'status_line';

export interface NativeParam {
  readonly name: string;
  readonly type: NativeTypeRef;
  // The latest-known qualifier this parameter accepts: an argument must
  // satisfy qualifierLE(arg.qualifier, cap).
  readonly qualifierCap: Qualifier;
  readonly required: boolean;
  // The argument must fold to a compile-time constant VALUE (input defaults,
  // titles), not merely be const-qualified.
  readonly constLiteral: boolean;
  // Most Tea values are nullable, but host contracts can require a concrete
  // value (input defaults and settings metadata are the canonical examples).
  readonly acceptsNa: boolean;
  // Collects all remaining arguments (math.max(a, b, ...)); last param only.
  readonly variadic: boolean;
  // Expression capture (request's expression argument): the checker checks
  // this argument in a child context and the noder compiles it into a child
  // Program instead of evaluating it in place.
  readonly capture: boolean;
  readonly mode: 'value' | 'inout';
  // Staged parameters retain their positional ABI slot and appear in the
  // reference, but any supplied argument is rejected by the checker until
  // the owning runtime model exists.
  readonly availability: 'supported' | 'staged';
}

// The effect class selects the compilation and runtime protocol of a call:
// none = pure; param = extracts a Program ParamInput (input.*); declaration =
// script metadata (indicator/strategy); output = hoisted OutputDecl + per-bar
// Emit (plot family); handle = per-bar host drawing-object ops (line.*);
// host = host service with next-bar feedback (strategy.*); async = awaited
// host call (llm); request = compiles a child Program (request.*).
export const Effect = {
  None: 'none',
  Param: 'param',
  Declaration: 'declaration',
  Output: 'output',
  Handle: 'handle',
  Host: 'host',
  Async: 'async',
  Request: 'request',
  Emit: 'emit',
} as const;

export type NativeEffect = (typeof Effect)[keyof typeof Effect];

// JoinResult marks a result qualifier computed as the later-known qualifier
// of the actual arguments (const when there are none).
export const JoinResult = 'join';

export type ResultQualifier = Qualifier | typeof JoinResult;

// One overload of a native function.
export interface NativeFunc {
  readonly name: string;
  readonly typeParams: readonly NativeTypeParam[];
  readonly params: readonly NativeParam[];
  readonly result: NativeResult;
  readonly resultQualifier: ResultQualifier;
  readonly effect: NativeEffect;
  // Mints a per-call-site SlotId (a sub-frame in the caller's frame). None of
  // the seed natives carry slot state; ta.* is prelude and gets its state
  // from ordinary function semantics.
  readonly stateful: boolean;
  // Param controls have a concrete display default. null on every non-param
  // native keeps the catalog as the sole owner of this host-visible default.
  readonly inputDefaultDisplay: InputDisplay | null;
}

// The catalog classifies every non-const builtin explicitly. No downstream
// pass may infer its runtime carrier by parsing the source spelling.
export type BuiltinBinding =
  | {readonly kind: 'series'; readonly id: DataSeriesId}
  | {readonly kind: 'builtin'; readonly source: BuiltinSource};

interface NativeVarBase {
  readonly name: string;
  readonly type: Type;
}

export interface NativeConstVar extends NativeVarBase {
  readonly qualifier: typeof Qualifier.Const;
  readonly value: ConstValue;
  readonly binding: null;
}

export interface NativeBoundVar extends NativeVarBase {
  readonly qualifier: Exclude<Qualifier, typeof Qualifier.Const>;
  readonly value: null;
  readonly binding: BuiltinBinding;
}

// A host-provided context builtin (close, syminfo.tickerid) or const namespace
// member (color.red, plot.style_line, math.pi). Constants have no runtime
// binding; all other entries carry one explicit series/builtin binding.
export type NativeVar = NativeConstVar | NativeBoundVar;

export interface Catalog {
  readonly funcs: ReadonlyMap<string, readonly NativeFunc[]>;
  readonly vars: ReadonlyMap<string, NativeVar>;
}

// ---- entry builders ---------------------------------------------------------

interface NativeParamOptions {
  readonly literal?: boolean;
  readonly variadic?: boolean;
  readonly capture?: boolean;
  readonly acceptsNa?: boolean;
  readonly mode?: 'value' | 'inout';
  readonly availability?: 'supported' | 'staged';
}

function req(
  name: string,
  type: NativeTypeRef,
  qualifierCap: Qualifier,
  opts: NativeParamOptions = {},
): NativeParam {
  return {
    name,
    type,
    qualifierCap,
    required: true,
    constLiteral: opts.literal ?? false,
    acceptsNa: opts.acceptsNa ?? true,
    variadic: opts.variadic ?? false,
    capture: opts.capture ?? false,
    mode: opts.mode ?? 'value',
    availability: opts.availability ?? 'supported',
  };
}

function opt(
  name: string,
  type: NativeTypeRef,
  qualifierCap: Qualifier,
  opts: NativeParamOptions = {},
): NativeParam {
  return {...req(name, type, qualifierCap, opts), required: false};
}

function func(
  name: string,
  params: readonly NativeParam[],
  result: NativeResult,
  resultQualifier: ResultQualifier,
  effect: NativeEffect = Effect.None,
  inputDefaultDisplay: InputDisplay | null = null,
): NativeFunc {
  return {
    name,
    typeParams: [],
    params,
    result,
    resultQualifier,
    effect,
    stateful: false,
    inputDefaultDisplay,
  };
}

function genericFunc(
  name: string,
  typeParams: readonly NativeTypeParam[],
  params: readonly NativeParam[],
  result: NativeResult,
  resultQualifier: ResultQualifier,
  effect: NativeEffect = Effect.None,
): NativeFunc {
  return {
    ...func(name, params, result, resultQualifier, effect),
    typeParams,
  };
}

function constantVariable(
  name: string,
  type: Type,
  value: ConstValue,
): NativeVar {
  return {name, type, qualifier: Qualifier.Const, value, binding: null};
}

function seriesVariable(name: string, type: Type): NativeVar {
  return {
    name,
    type,
    qualifier: Qualifier.Series,
    value: null,
    binding: {kind: 'series', id: name},
  };
}

function builtinVariable(
  name: string,
  type: Type,
  qualifier: Exclude<Qualifier, typeof Qualifier.Const>,
  source: BuiltinSource,
): NativeVar {
  return {
    name,
    type,
    qualifier,
    value: null,
    binding: {kind: 'builtin', source},
  };
}

// ---- context builtins -------------------------------------------------------

const SERIES_FLOAT_VARS = [
  'open',
  'high',
  'low',
  'close',
  'volume',
  'hl2',
  'hlc3',
  'ohlc4',
  'hlcc4',
];

const BARSTATE_FIELDS = [
  'isfirst',
  'islast',
  'ishistory',
  'isrealtime',
  'isconfirmed',
  'isnew',
] satisfies readonly Extract<BuiltinSource, {domain: 'barstate'}>['field'][];

// Tea's palette (Tea-owned hues, not host-owned).
const COLORS: Record<string, string> = {
  aqua: '#00BCD4',
  black: '#000000',
  blue: '#2196F3',
  fuchsia: '#E91E63',
  gray: '#787B86',
  green: '#4CAF50',
  lime: '#00E676',
  maroon: '#880E4F',
  navy: '#311B92',
  olive: '#808000',
  orange: '#FF9800',
  purple: '#9C27B0',
  red: '#FF5252',
  silver: '#B2B5BE',
  teal: '#00897B',
  white: '#FFFFFF',
  yellow: '#FFEB3B',
};

// Keys are full name prefixes (separator included): plot.style_line,
// location.abovebar. Values double as both member name and const value.
const STRING_CONSTS: Record<string, readonly string[]> = {
  'plot.style_': [
    'line',
    'stepline',
    'histogram',
    'columns',
    'area',
    'circles',
    'cross',
    'linebr',
    'areabr',
  ],
  'hline.style_': ['solid', 'dotted', 'dashed'],
  'location.': ['abovebar', 'belowbar', 'top', 'bottom', 'absolute'],
  'shape.': [
    'xcross',
    'cross',
    'triangleup',
    'triangledown',
    'flag',
    'circle',
    'arrowup',
    'arrowdown',
    'labelup',
    'labeldown',
    'square',
    'diamond',
  ],
  'size.': ['auto', 'tiny', 'small', 'normal', 'large', 'huge'],
  'display.': [
    'none',
    'all',
    'data_window',
    'pane',
    'price_scale',
    'status_line',
  ],
  'format.': ['inherit', 'price', 'volume', 'percent'],
  // Table anchors: the constants are plain strings even while table.* itself
  // is staged with the drawing runtime — scripts fail on table.new, not on
  // the anchor vocabulary.
  'position.': [
    'top_left',
    'top_center',
    'top_right',
    'middle_left',
    'middle_center',
    'middle_right',
    'bottom_left',
    'bottom_center',
    'bottom_right',
  ],
};

function buildVars(): NativeVar[] {
  const vars: NativeVar[] = [
    // Literal-like names the scanner deliberately leaves as plain names.
    constantVariable('true', BoolType, true),
    constantVariable('false', BoolType, false),
    constantVariable('na', NaType, NA_VALUE),
    builtinVariable('bar_index', IntType, Qualifier.Series, {
      domain: 'bar',
      field: 'bar_index',
    }),
    builtinVariable('last_bar_index', IntType, Qualifier.Series, {
      domain: 'bar',
      field: 'last_bar_index',
    }),
    builtinVariable('time', IntType, Qualifier.Series, {
      domain: 'time',
      field: 'time',
    }),
    builtinVariable('time_close', IntType, Qualifier.Series, {
      domain: 'time',
      field: 'time_close',
    }),
    builtinVariable('timenow', IntType, Qualifier.Series, {
      domain: 'time',
      field: 'timenow',
    }),
    constantVariable('barmerge.gaps_on', BoolType, true),
    constantVariable('barmerge.gaps_off', BoolType, false),
    constantVariable('barmerge.lookahead_on', BoolType, true),
    constantVariable('barmerge.lookahead_off', BoolType, false),
    constantVariable('math.pi', FloatType, Math.PI),
    constantVariable('math.e', FloatType, Math.E),
    builtinVariable('syminfo.tickerid', StringType, Qualifier.Simple, {
      domain: 'syminfo',
      field: 'tickerid',
    }),
    builtinVariable('syminfo.ticker', StringType, Qualifier.Simple, {
      domain: 'syminfo',
      field: 'ticker',
    }),
    builtinVariable('syminfo.prefix', StringType, Qualifier.Simple, {
      domain: 'syminfo',
      field: 'prefix',
    }),
    builtinVariable('syminfo.currency', StringType, Qualifier.Simple, {
      domain: 'syminfo',
      field: 'currency',
    }),
    builtinVariable('syminfo.basecurrency', StringType, Qualifier.Simple, {
      domain: 'syminfo',
      field: 'basecurrency',
    }),
    builtinVariable('syminfo.type', StringType, Qualifier.Simple, {
      domain: 'syminfo',
      field: 'type',
    }),
    builtinVariable('syminfo.timezone', StringType, Qualifier.Simple, {
      domain: 'syminfo',
      field: 'timezone',
    }),
    builtinVariable('syminfo.mintick', FloatType, Qualifier.Simple, {
      domain: 'syminfo',
      field: 'mintick',
    }),
    builtinVariable('syminfo.pointvalue', FloatType, Qualifier.Simple, {
      domain: 'syminfo',
      field: 'pointvalue',
    }),
    builtinVariable('timeframe.period', StringType, Qualifier.Simple, {
      domain: 'timeframe',
      field: 'period',
    }),
    builtinVariable('timeframe.multiplier', IntType, Qualifier.Simple, {
      domain: 'timeframe',
      field: 'multiplier',
    }),
    builtinVariable('timeframe.isseconds', BoolType, Qualifier.Simple, {
      domain: 'timeframe',
      field: 'isseconds',
    }),
    builtinVariable('timeframe.isminutes', BoolType, Qualifier.Simple, {
      domain: 'timeframe',
      field: 'isminutes',
    }),
    builtinVariable('timeframe.isintraday', BoolType, Qualifier.Simple, {
      domain: 'timeframe',
      field: 'isintraday',
    }),
    builtinVariable('timeframe.isdaily', BoolType, Qualifier.Simple, {
      domain: 'timeframe',
      field: 'isdaily',
    }),
    builtinVariable('timeframe.isweekly', BoolType, Qualifier.Simple, {
      domain: 'timeframe',
      field: 'isweekly',
    }),
    builtinVariable('timeframe.ismonthly', BoolType, Qualifier.Simple, {
      domain: 'timeframe',
      field: 'ismonthly',
    }),
    builtinVariable('timeframe.isdwm', BoolType, Qualifier.Simple, {
      domain: 'timeframe',
      field: 'isdwm',
    }),
  ];
  for (const name of SERIES_FLOAT_VARS) {
    vars.push(seriesVariable(name, FloatType));
  }
  for (const field of BARSTATE_FIELDS) {
    vars.push(
      builtinVariable(`barstate.${field}`, BoolType, Qualifier.Series, {
        domain: 'barstate',
        field,
      }),
    );
  }
  for (const [name, hex] of Object.entries(COLORS)) {
    vars.push(constantVariable(`color.${name}`, ColorType, hex));
  }
  for (const [prefix, members] of Object.entries(STRING_CONSTS)) {
    for (const member of members) {
      vars.push(constantVariable(`${prefix}${member}`, StringType, member));
    }
  }
  return vars;
}

// ---- functions --------------------------------------------------------------

const CONCRETE_CONST_VALUE = {literal: true, acceptsNa: false} as const;
const CONCRETE_CONST_NUMBER = {literal: true, acceptsNa: false} as const;

function inputParam(
  name: string,
  params: readonly NativeParam[],
  result: NativeResult,
  resultQualifier: Qualifier,
  defaultDisplay: InputDisplay,
): NativeFunc {
  return func(
    name,
    params,
    result,
    resultQualifier,
    Effect.Param,
    defaultDisplay,
  );
}

function active(): NativeParam {
  return opt('active', BoolType, Qualifier.Input, {acceptsNa: false});
}

function displayAndActive(): NativeParam[] {
  return [
    opt('display', StringType, Qualifier.Const, CONCRETE_CONST_VALUE),
    active(),
  ];
}

function standardInputMetadata(): NativeParam[] {
  return [
    opt('tooltip', StringType, Qualifier.Const, CONCRETE_CONST_VALUE),
    opt('inline', StringType, Qualifier.Const, CONCRETE_CONST_VALUE),
    opt('group', StringType, Qualifier.Const, CONCRETE_CONST_VALUE),
  ];
}

function confirmedInputTail(): NativeParam[] {
  return [
    ...standardInputMetadata(),
    opt('confirm', BoolType, Qualifier.Const, CONCRETE_CONST_VALUE),
    ...displayAndActive(),
  ];
}

function scalarInput(
  name: string,
  type: Type,
  defaultDisplay: InputDisplay,
): NativeFunc {
  return inputParam(
    name,
    [
      req('defval', type, Qualifier.Const, CONCRETE_CONST_VALUE),
      opt('title', StringType, Qualifier.Const, CONCRETE_CONST_VALUE),
      ...confirmedInputTail(),
    ],
    type,
    Qualifier.Input,
    defaultDisplay,
  );
}

function optionsInput(
  name: string,
  type: Type,
  defaultDisplay: InputDisplay,
): NativeFunc {
  return inputParam(
    name,
    [
      req('defval', type, Qualifier.Const, CONCRETE_CONST_VALUE),
      opt('title', StringType, Qualifier.Const, CONCRETE_CONST_VALUE),
      opt('options', TypeRef.Any, Qualifier.Const),
      ...confirmedInputTail(),
    ],
    type,
    Qualifier.Input,
    defaultDisplay,
  );
}

function numericInput(name: string, type: Type): NativeFunc[] {
  const trailing = confirmedInputTail();
  return [
    inputParam(
      name,
      [
        req('defval', type, Qualifier.Const, CONCRETE_CONST_VALUE),
        opt('title', StringType, Qualifier.Const, CONCRETE_CONST_VALUE),
        opt('minval', type, Qualifier.Const, CONCRETE_CONST_NUMBER),
        opt('maxval', type, Qualifier.Const, CONCRETE_CONST_NUMBER),
        opt('step', type, Qualifier.Const, CONCRETE_CONST_NUMBER),
        ...trailing,
      ],
      type,
      Qualifier.Input,
      'all',
    ),
    inputParam(
      name,
      [
        req('defval', type, Qualifier.Const, CONCRETE_CONST_VALUE),
        opt('title', StringType, Qualifier.Const, CONCRETE_CONST_VALUE),
        req('options', TypeRef.Any, Qualifier.Const),
        ...trailing,
      ],
      type,
      Qualifier.Input,
      'all',
    ),
  ];
}

function textAreaInput(): NativeFunc {
  return inputParam(
    'input.text_area',
    [
      req('defval', StringType, Qualifier.Const, CONCRETE_CONST_VALUE),
      opt('title', StringType, Qualifier.Const, CONCRETE_CONST_VALUE),
      opt('tooltip', StringType, Qualifier.Const, CONCRETE_CONST_VALUE),
      opt('group', StringType, Qualifier.Const, CONCRETE_CONST_VALUE),
      opt('confirm', BoolType, Qualifier.Const, CONCRETE_CONST_VALUE),
      ...displayAndActive(),
    ],
    StringType,
    Qualifier.Input,
    'none',
  );
}

function sourceInput(name: 'input.source' | 'input'): NativeFunc {
  // input.source keeps confirm last in Pine v6. Bare input(source) has no
  // confirm and orders inline/group before tooltip.
  const tail =
    name === 'input.source'
      ? [
          ...standardInputMetadata(),
          ...displayAndActive(),
          opt('confirm', BoolType, Qualifier.Const, CONCRETE_CONST_VALUE),
        ]
      : [
          opt('inline', StringType, Qualifier.Const, CONCRETE_CONST_VALUE),
          opt('group', StringType, Qualifier.Const, CONCRETE_CONST_VALUE),
          opt('tooltip', StringType, Qualifier.Const, CONCRETE_CONST_VALUE),
          ...displayAndActive(),
        ];
  return inputParam(
    name,
    [
      req('defval', FloatType, Qualifier.Series, {acceptsNa: false}),
      opt('title', StringType, Qualifier.Const, CONCRETE_CONST_VALUE),
      ...tail,
    ],
    FloatType,
    Qualifier.Series,
    'all',
  );
}

function genericScalarInput(
  type: Type,
  defaultDisplay: InputDisplay,
): NativeFunc {
  return inputParam(
    'input',
    [
      req('defval', type, Qualifier.Const, CONCRETE_CONST_VALUE),
      opt('title', StringType, Qualifier.Const, CONCRETE_CONST_VALUE),
      ...standardInputMetadata(),
      ...displayAndActive(),
    ],
    type,
    Qualifier.Input,
    defaultDisplay,
  );
}

function enumInput(): NativeFunc {
  return inputParam(
    'input.enum',
    [
      req('defval', TypeRef.Enum, Qualifier.Const, CONCRETE_CONST_VALUE),
      opt('title', StringType, Qualifier.Const, CONCRETE_CONST_VALUE),
      opt('options', TypeRef.Any, Qualifier.Const),
      ...confirmedInputTail(),
    ],
    FirstArgumentResult,
    Qualifier.Input,
    'all',
  );
}

// Numeric math native where int and float overloads share one result rule.
// result null = the overload's own numeric type (abs: int stays int).
function mathNum(
  name: string,
  arity: number,
  result: Type | null,
): NativeFunc[] {
  return [IntType, FloatType].map(t => {
    const params = Array.from({length: arity}, (_, i) =>
      req(i === 0 ? 'number' : `number${i}`, t, Qualifier.Series),
    );
    return func(`math.${name}`, params, result ?? t, JoinResult);
  });
}

function buildFuncs(): NativeFunc[] {
  const funcs: NativeFunc[] = [];

  // The sole dense-output declaration intrinsic. Its contextual args object
  // and kind-dependent result are checked by checkOutput rather than ordinary
  // overload matching; this catalog entry owns only its intrinsic identity.
  funcs.push(
    func(
      'output',
      [
        req('value', TypeRef.Any, Qualifier.Series),
        req('kind', StringType, Qualifier.Const),
        req('args', TypeRef.Any, Qualifier.Series),
      ],
      VoidType,
      Qualifier.Const,
      Effect.Output,
    ),
  );

  // Generic sparse side effects. This is a checker-owned intrinsic namespace,
  // not a source library; codegen lowers each semantic call site to one typed
  // Program effect declaration.
  const effectValue = {kind: 'type-param', name: 'T'} as const;
  funcs.push(
    genericFunc(
      'effect.emit',
      [{name: 'T', constraint: 'effect-payload'}],
      [req('value', effectValue, Qualifier.Series)],
      VoidType,
      Qualifier.Const,
      Effect.Emit,
    ),
  );

  // Script declarations.
  funcs.push(
    func(
      'library',
      [req('title', StringType, Qualifier.Const, {literal: true})],
      VoidType,
      Qualifier.Const,
      Effect.Declaration,
    ),
    func(
      'indicator',
      [
        req('title', StringType, Qualifier.Const, {literal: true}),
        opt('shorttitle', StringType, Qualifier.Const, {literal: true}),
        opt('overlay', BoolType, Qualifier.Const, {literal: true}),
        opt('format', StringType, Qualifier.Const),
        opt('precision', IntType, Qualifier.Const, {literal: true}),
        opt('max_bars_back', IntType, Qualifier.Const, CONCRETE_CONST_NUMBER),
        opt('timeframe', StringType, Qualifier.Const),
        opt('timeframe_gaps', BoolType, Qualifier.Const, {literal: true}),
        // Pine v6: default true; false restores the static-only gate on
        // request context args (enforced by the noder).
        opt('dynamic_requests', BoolType, Qualifier.Const, {literal: true}),
        // Drawing-object budgets: recorded as script metadata now; the
        // drawing runtime enforces them when handle objects land.
        opt('max_lines_count', IntType, Qualifier.Const, {literal: true}),
        opt('max_labels_count', IntType, Qualifier.Const, {literal: true}),
        opt('max_boxes_count', IntType, Qualifier.Const, {literal: true}),
        opt('max_polylines_count', IntType, Qualifier.Const, {literal: true}),
        opt('calc_bars_count', IntType, Qualifier.Const, {literal: true}),
      ],
      VoidType,
      Qualifier.Const,
      Effect.Declaration,
    ),
    func(
      'strategy',
      [
        req('title', StringType, Qualifier.Const, {literal: true}),
        opt('shorttitle', StringType, Qualifier.Const, {literal: true}),
        opt('overlay', BoolType, Qualifier.Const, {literal: true}),
      ],
      VoidType,
      Qualifier.Const,
      Effect.Declaration,
    ),
  );

  // input.* — the param family: the checker extracts the declaration, the
  // runtime supplies the value at bind time. input.source's result is
  // series: the bound value is a per-bar stream, not a bind-time scalar.
  funcs.push(
    ...numericInput('input.int', IntType),
    ...numericInput('input.float', FloatType),
    scalarInput('input.bool', BoolType, 'none'),
    optionsInput('input.string', StringType, 'all'),
    scalarInput('input.color', ColorType, 'none'),
    optionsInput('input.timeframe', StringType, 'all'),
    scalarInput('input.symbol', StringType, 'all'),
    scalarInput('input.price', FloatType, 'all'),
    optionsInput('input.session', StringType, 'all'),
    scalarInput('input.time', IntType, 'none'),
    textAreaInput(),
    sourceInput('input.source'),
    enumInput(),
  );
  funcs.push(
    genericScalarInput(IntType, 'all'),
    genericScalarInput(FloatType, 'all'),
    genericScalarInput(BoolType, 'none'),
    genericScalarInput(StringType, 'all'),
    genericScalarInput(ColorType, 'none'),
    sourceInput('input'),
  );

  // Declarative outputs.
  funcs.push(
    func(
      'hline',
      [
        req('price', FloatType, Qualifier.Input),
        opt('title', StringType, Qualifier.Const, {literal: true}),
        opt('color', ColorType, Qualifier.Input),
        opt('linestyle', StringType, Qualifier.Const),
        opt('linewidth', IntType, Qualifier.Input),
        opt('editable', BoolType, Qualifier.Const),
        opt('display', StringType, Qualifier.Const),
      ],
      HlineType,
      Qualifier.Const,
      Effect.Output,
    ),
    func(
      'plotshape',
      [
        req('series', BoolType, Qualifier.Series),
        opt('title', StringType, Qualifier.Const, {literal: true}),
        opt('style', StringType, Qualifier.Const),
        opt('location', StringType, Qualifier.Const),
        opt('color', ColorType, Qualifier.Series),
        opt('offset', IntType, Qualifier.Input),
        opt('text', StringType, Qualifier.Const),
        opt('textcolor', ColorType, Qualifier.Series),
        opt('size', StringType, Qualifier.Const),
        opt('editable', BoolType, Qualifier.Const),
        opt('show_last', IntType, Qualifier.Input),
        opt('display', StringType, Qualifier.Const),
      ],
      VoidType,
      Qualifier.Const,
      Effect.Output,
    ),
    func(
      'plotchar',
      [
        req('series', BoolType, Qualifier.Series),
        opt('title', StringType, Qualifier.Const, {literal: true}),
        opt('char', StringType, Qualifier.Const),
        opt('location', StringType, Qualifier.Const),
        opt('color', ColorType, Qualifier.Series),
        opt('offset', IntType, Qualifier.Input),
        opt('text', StringType, Qualifier.Const),
        opt('textcolor', ColorType, Qualifier.Series),
        opt('size', StringType, Qualifier.Const),
        opt('editable', BoolType, Qualifier.Const),
        opt('show_last', IntType, Qualifier.Input),
        opt('display', StringType, Qualifier.Const),
      ],
      VoidType,
      Qualifier.Const,
      Effect.Output,
    ),
    func(
      'bgcolor',
      [
        req('color', ColorType, Qualifier.Series),
        opt('title', StringType, Qualifier.Const, {literal: true}),
        opt('offset', IntType, Qualifier.Input),
        opt('editable', BoolType, Qualifier.Const),
        opt('show_last', IntType, Qualifier.Input),
        opt('display', StringType, Qualifier.Const),
      ],
      VoidType,
      Qualifier.Const,
      Effect.Output,
    ),
    func(
      'barcolor',
      [
        req('color', ColorType, Qualifier.Series),
        opt('title', StringType, Qualifier.Const, {literal: true}),
        opt('offset', IntType, Qualifier.Input),
        opt('editable', BoolType, Qualifier.Const),
        opt('show_last', IntType, Qualifier.Input),
        opt('display', StringType, Qualifier.Const),
      ],
      VoidType,
      Qualifier.Const,
      Effect.Output,
    ),
    func(
      'alertcondition',
      [
        req('condition', BoolType, Qualifier.Series),
        opt('title', StringType, Qualifier.Const, {literal: true}),
        opt('message', StringType, Qualifier.Const, {literal: true}),
      ],
      VoidType,
      Qualifier.Const,
      Effect.Output,
    ),
  );
  for (const refType of [PlotType, HlineType]) {
    funcs.push(
      func(
        'fill',
        [
          req('plot1', refType, Qualifier.Const),
          req('plot2', refType, Qualifier.Const),
          opt('color', ColorType, Qualifier.Series),
          opt('title', StringType, Qualifier.Const, {literal: true}),
          opt('editable', BoolType, Qualifier.Const),
          opt('display', StringType, Qualifier.Const),
        ],
        VoidType,
        Qualifier.Const,
        Effect.Output,
      ),
    );
  }

  // math.* — intrinsics only; aggregations over time (ta.*) are prelude.
  funcs.push(
    ...mathNum('abs', 1, null),
    ...mathNum('sign', 1, null),
    func(
      'math.floor',
      [req('number', TypeRef.Num, Qualifier.Series)],
      IntType,
      JoinResult,
    ),
    func(
      'math.ceil',
      [req('number', TypeRef.Num, Qualifier.Series)],
      IntType,
      JoinResult,
    ),
    func(
      'math.round',
      [req('number', TypeRef.Num, Qualifier.Series)],
      IntType,
      JoinResult,
    ),
    func(
      'math.round',
      [
        req('number', TypeRef.Num, Qualifier.Series),
        req('precision', IntType, Qualifier.Series),
      ],
      FloatType,
      JoinResult,
    ),
    func(
      'math.sqrt',
      [req('number', TypeRef.Num, Qualifier.Series)],
      FloatType,
      JoinResult,
    ),
    func(
      'math.pow',
      [
        req('base', TypeRef.Num, Qualifier.Series),
        req('exponent', TypeRef.Num, Qualifier.Series),
      ],
      FloatType,
      JoinResult,
    ),
    func(
      'math.log',
      [req('number', TypeRef.Num, Qualifier.Series)],
      FloatType,
      JoinResult,
    ),
    func(
      'math.log10',
      [req('number', TypeRef.Num, Qualifier.Series)],
      FloatType,
      JoinResult,
    ),
    func(
      'math.exp',
      [req('number', TypeRef.Num, Qualifier.Series)],
      FloatType,
      JoinResult,
    ),
    func(
      'math.avg',
      [req('number', TypeRef.Num, Qualifier.Series, {variadic: true})],
      FloatType,
      JoinResult,
    ),
  );
  for (const name of ['math.max', 'math.min']) {
    funcs.push(
      func(
        name,
        [
          req('number', IntType, Qualifier.Series),
          req('number1', IntType, Qualifier.Series, {variadic: true}),
        ],
        IntType,
        JoinResult,
      ),
      func(
        name,
        [
          req('number', TypeRef.Num, Qualifier.Series),
          req('number1', TypeRef.Num, Qualifier.Series, {variadic: true}),
        ],
        FloatType,
        JoinResult,
      ),
    );
  }

  // Context capture. The declared result type is a placeholder: a request's
  // result takes the captured expression's type, resolved per call site by
  // the checker; the result qualifier is always series.
  funcs.push(
    func(
      'request.security',
      [
        req('symbol', StringType, Qualifier.Series, {acceptsNa: false}),
        req('timeframe', StringType, Qualifier.Series, {acceptsNa: false}),
        req('expression', TypeRef.Any, Qualifier.Series, {capture: true}),
        opt('gaps', BoolType, Qualifier.Simple),
        opt('lookahead', BoolType, Qualifier.Simple),
        opt('ignore_invalid_symbol', BoolType, Qualifier.Simple, {
          acceptsNa: false,
        }),
        opt('currency', StringType, Qualifier.Const, {
          availability: 'staged',
        }),
        opt('calc_bars_count', IntType, Qualifier.Simple, {acceptsNa: false}),
      ],
      FloatType,
      Qualifier.Series,
      Effect.Request,
    ),
    func(
      'request.security_lower_tf',
      [
        req('symbol', StringType, Qualifier.Series, {acceptsNa: false}),
        req('timeframe', StringType, Qualifier.Series, {acceptsNa: false}),
        req('expression', TypeRef.Any, Qualifier.Series, {capture: true}),
      ],
      FloatType,
      Qualifier.Series,
      Effect.Request,
    ),
  );

  // na handling and conversions.
  funcs.push(
    func(
      'na',
      [req('x', TypeRef.Nullable, Qualifier.Series)],
      BoolType,
      JoinResult,
    ),
  );
  for (const t of [IntType, FloatType, ColorType]) {
    funcs.push(
      func(
        'nz',
        [
          req('source', t, Qualifier.Series),
          opt('replacement', t, Qualifier.Series),
        ],
        t,
        JoinResult,
      ),
    );
  }
  // fixnan is deliberately absent: it carries state (the last non-na value)
  // and needs either a stateful-native slot or a bare-name prelude
  // mechanism; libraries inline the var pattern meanwhile.
  funcs.push(
    func('int', [req('x', TypeRef.Num, Qualifier.Series)], IntType, JoinResult),
    func(
      'float',
      [req('x', TypeRef.Num, Qualifier.Series)],
      FloatType,
      JoinResult,
    ),
    func(
      'str.tostring',
      [req('value', TypeRef.StringConvertible, Qualifier.Series)],
      StringType,
      JoinResult,
    ),
    func(
      'color.new',
      [
        req('color', ColorType, Qualifier.Series),
        req('transp', TypeRef.Num, Qualifier.Series),
      ],
      ColorType,
      JoinResult,
    ),
    func(
      'color.rgb',
      [
        req('red', TypeRef.Num, Qualifier.Series),
        req('green', TypeRef.Num, Qualifier.Series),
        req('blue', TypeRef.Num, Qualifier.Series),
        opt('transp', TypeRef.Num, Qualifier.Series),
      ],
      ColorType,
      JoinResult,
    ),
  );

  const t: TypeParamRef = {kind: 'type-param', name: 'T'};
  const k: TypeParamRef = {kind: 'type-param', name: 'K'};
  const v: TypeParamRef = {kind: 'type-param', name: 'V'};
  const arrayT: GenericTypeRef = {kind: 'array', element: t};
  const matrixT: GenericTypeRef = {kind: 'matrix', element: t};
  const mapKV: GenericTypeRef = {kind: 'map', key: k, value: v};
  const storableT: readonly NativeTypeParam[] = [
    {name: 'T', constraint: 'storable'},
  ];
  const mapKVParams: readonly NativeTypeParam[] = [
    {name: 'K', constraint: 'map-key'},
    {name: 'V', constraint: 'storable'},
  ];
  const self = (
    type: NativeTypeRef,
    mode: 'value' | 'inout' = 'value',
  ): NativeParam => req('self', type, Qualifier.Series, {mode});

  // Collections are host primitives because persistent storage and atomic
  // location replacement cannot be expressed in Tea source. Namespace and
  // method spellings resolve to these same catalog entries.
  funcs.push(
    genericFunc('array.new', storableT, [], arrayT, Qualifier.Const),
    genericFunc(
      'array.new',
      storableT,
      [
        req('size', IntType, Qualifier.Series, {acceptsNa: false}),
        opt('initial', t, Qualifier.Series),
      ],
      arrayT,
      JoinResult,
    ),
    genericFunc(
      'array.from',
      storableT,
      [opt('values', t, Qualifier.Series, {variadic: true})],
      arrayT,
      JoinResult,
    ),
    genericFunc('array.size', storableT, [self(arrayT)], IntType, JoinResult),
    genericFunc(
      'array.is_empty',
      storableT,
      [self(arrayT)],
      BoolType,
      JoinResult,
    ),
    genericFunc(
      'array.get',
      storableT,
      [self(arrayT), req('index', IntType, Qualifier.Series)],
      t,
      JoinResult,
    ),
    genericFunc('array.first', storableT, [self(arrayT)], t, JoinResult),
    genericFunc('array.last', storableT, [self(arrayT)], t, JoinResult),
    genericFunc(
      'array.set',
      storableT,
      [
        self(arrayT, 'inout'),
        req('index', IntType, Qualifier.Series),
        req('value', t, Qualifier.Series),
      ],
      VoidType,
      JoinResult,
    ),
    genericFunc(
      'array.push',
      storableT,
      [self(arrayT, 'inout'), req('value', t, Qualifier.Series)],
      VoidType,
      JoinResult,
    ),
    genericFunc('array.pop', storableT, [self(arrayT, 'inout')], t, JoinResult),
    genericFunc(
      'array.clear',
      storableT,
      [self(arrayT, 'inout')],
      VoidType,
      JoinResult,
    ),
    genericFunc('array.copy', storableT, [self(arrayT)], arrayT, JoinResult),
    genericFunc('matrix.new', storableT, [], matrixT, Qualifier.Const),
    genericFunc(
      'matrix.new',
      storableT,
      [
        req('rows', IntType, Qualifier.Series, {acceptsNa: false}),
        req('columns', IntType, Qualifier.Series, {acceptsNa: false}),
        req('initial', t, Qualifier.Series),
      ],
      matrixT,
      JoinResult,
    ),
    genericFunc('matrix.rows', storableT, [self(matrixT)], IntType, JoinResult),
    genericFunc(
      'matrix.columns',
      storableT,
      [self(matrixT)],
      IntType,
      JoinResult,
    ),
    genericFunc(
      'matrix.elements_count',
      storableT,
      [self(matrixT)],
      IntType,
      JoinResult,
    ),
    genericFunc(
      'matrix.get',
      storableT,
      [
        self(matrixT),
        req('row', IntType, Qualifier.Series),
        req('column', IntType, Qualifier.Series),
      ],
      t,
      JoinResult,
    ),
    genericFunc(
      'matrix.set',
      storableT,
      [
        self(matrixT, 'inout'),
        req('row', IntType, Qualifier.Series),
        req('column', IntType, Qualifier.Series),
        req('value', t, Qualifier.Series),
      ],
      VoidType,
      JoinResult,
    ),
    genericFunc(
      'matrix.fill',
      storableT,
      [self(matrixT, 'inout'), req('value', t, Qualifier.Series)],
      VoidType,
      JoinResult,
    ),
    genericFunc(
      'matrix.row',
      storableT,
      [self(matrixT), req('row', IntType, Qualifier.Series)],
      arrayT,
      JoinResult,
    ),
    genericFunc(
      'matrix.column',
      storableT,
      [self(matrixT), req('column', IntType, Qualifier.Series)],
      arrayT,
      JoinResult,
    ),
    genericFunc('matrix.copy', storableT, [self(matrixT)], matrixT, JoinResult),
    genericFunc('map.new', mapKVParams, [], mapKV, Qualifier.Const),
    genericFunc('map.size', mapKVParams, [self(mapKV)], IntType, JoinResult),
    genericFunc(
      'map.is_empty',
      mapKVParams,
      [self(mapKV)],
      BoolType,
      JoinResult,
    ),
    genericFunc(
      'map.contains',
      mapKVParams,
      [self(mapKV), req('key', k, Qualifier.Series, {acceptsNa: false})],
      BoolType,
      JoinResult,
    ),
    genericFunc(
      'map.get',
      mapKVParams,
      [self(mapKV), req('key', k, Qualifier.Series, {acceptsNa: false})],
      v,
      JoinResult,
    ),
    genericFunc(
      'map.put',
      mapKVParams,
      [
        self(mapKV, 'inout'),
        req('key', k, Qualifier.Series, {acceptsNa: false}),
        req('value', v, Qualifier.Series),
      ],
      VoidType,
      JoinResult,
    ),
    genericFunc(
      'map.remove',
      mapKVParams,
      [
        self(mapKV, 'inout'),
        req('key', k, Qualifier.Series, {acceptsNa: false}),
      ],
      v,
      JoinResult,
    ),
    genericFunc(
      'map.clear',
      mapKVParams,
      [self(mapKV, 'inout')],
      VoidType,
      JoinResult,
    ),
    genericFunc(
      'map.keys',
      mapKVParams,
      [self(mapKV)],
      {kind: 'array', element: k},
      JoinResult,
    ),
    genericFunc(
      'map.values',
      mapKVParams,
      [self(mapKV)],
      {kind: 'array', element: v},
      JoinResult,
    ),
    genericFunc('map.copy', mapKVParams, [self(mapKV)], mapKV, JoinResult),
  );

  return funcs;
}

// ---- catalog assembly -------------------------------------------------------

function buildCatalog(): Catalog {
  const funcs = new Map<string, NativeFunc[]>();
  for (const entry of buildFuncs()) {
    const overloads = funcs.get(entry.name);
    if (overloads === undefined) {
      funcs.set(entry.name, [entry]);
    } else {
      overloads.push(entry);
    }
  }
  const vars = new Map<string, NativeVar>();
  for (const entry of buildVars()) {
    vars.set(entry.name, entry);
  }
  return {funcs, vars};
}

export const CATALOG: Catalog = buildCatalog();

export function nativeFuncs(name: string): readonly NativeFunc[] | null {
  return CATALOG.funcs.get(name) ?? null;
}

export function nativeVar(name: string): NativeVar | null {
  return CATALOG.vars.get(name) ?? null;
}

// True when `name` is a catalog entry or a namespace root of one (math,
// input, …) — declaring such a name would shadow the native surface.
export function isNativeRoot(name: string): boolean {
  if (CATALOG.funcs.has(name) || CATALOG.vars.has(name)) {
    return true;
  }
  const prefix = `${name}.`;
  for (const key of CATALOG.funcs.keys()) {
    if (key.startsWith(prefix)) {
      return true;
    }
  }
  for (const key of CATALOG.vars.keys()) {
    if (key.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}
