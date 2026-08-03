// Purpose: Native catalog — the single declaration surface for host primitives: signatures, qualifier caps, const-literal requirements, effect classes. A builtin is listed here only if it is inexpressible in Tea; all of ta.* is prelude code, never catalog.

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

// 'num' accepts anything assignable to float (int, float, na); overloads
// express result-type differences. 'any' accepts every value type (na(),
// str.tostring()).
export type NativeTypeRef = Type | 'num' | 'any';

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
  // Collects all remaining arguments (math.max(a, b, ...)); last param only.
  readonly variadic: boolean;
}

// The effect class selects the compilation and runtime protocol of a call:
// none = pure; param = extracts a Program ParamInput (input.*); declaration =
// script metadata (indicator/strategy); output = hoisted OutputDecl + per-bar
// Emit (plot family); handle = per-bar host drawing-object ops (line.*);
// host = host service with next-bar feedback (strategy.*); async = awaited
// host call (llm); request = compiles a child Program (request.*).
export type NativeEffect =
  | 'none'
  | 'param'
  | 'declaration'
  | 'output'
  | 'handle'
  | 'host'
  | 'async'
  | 'request';

// One overload of a native function. resultQualifier 'join' means the
// later-known qualifier of the actual arguments (const when there are none).
export interface NativeFunc {
  readonly name: string;
  readonly params: readonly NativeParam[];
  readonly result: Type;
  readonly resultQualifier: Qualifier | 'join';
  readonly effect: NativeEffect;
  // Mints a per-call-site SlotId (a sub-frame in the caller's frame). None of
  // the seed natives carry slot state; ta.* is prelude and gets its state
  // from ordinary function semantics.
  readonly stateful: boolean;
}

// An ambient variable (close, syminfo.tickerid) or const namespace member
// (color.red, plot.style_line, math.pi). Non-const vars are context series
// provided by the runtime, never declared by the Program.
export interface NativeVar {
  readonly name: string;
  readonly type: Type;
  readonly qualifier: Qualifier;
  readonly value: ConstValue | null;
}

export interface Catalog {
  readonly funcs: ReadonlyMap<string, readonly NativeFunc[]>;
  readonly vars: ReadonlyMap<string, NativeVar>;
}

// ---- entry builders ---------------------------------------------------------

function req(
  name: string,
  type: NativeTypeRef,
  qualifierCap: Qualifier,
  opts: {literal?: boolean; variadic?: boolean} = {},
): NativeParam {
  return {
    name,
    type,
    qualifierCap,
    required: true,
    constLiteral: opts.literal ?? false,
    variadic: opts.variadic ?? false,
  };
}

function opt(
  name: string,
  type: NativeTypeRef,
  qualifierCap: Qualifier,
  opts: {literal?: boolean; variadic?: boolean} = {},
): NativeParam {
  return {...req(name, type, qualifierCap, opts), required: false};
}

function func(
  name: string,
  params: readonly NativeParam[],
  result: Type,
  resultQualifier: Qualifier | 'join',
  effect: NativeEffect = 'none',
): NativeFunc {
  return {name, params, result, resultQualifier, effect, stateful: false};
}

function variable(
  name: string,
  type: Type,
  qualifier: Qualifier,
  value: ConstValue | null = null,
): NativeVar {
  return {name, type, qualifier, value};
}

// ---- ambient variables ------------------------------------------------------

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

const BARSTATE_VARS = [
  'barstate.isfirst',
  'barstate.islast',
  'barstate.ishistory',
  'barstate.isrealtime',
  'barstate.isconfirmed',
  'barstate.isnew',
];

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
};

function buildVars(): NativeVar[] {
  const vars: NativeVar[] = [
    // Literal-like names the scanner deliberately leaves as plain names.
    variable('true', BoolType, Qualifier.Const, true),
    variable('false', BoolType, Qualifier.Const, false),
    variable('na', NaType, Qualifier.Const, NA_VALUE),
    variable('bar_index', IntType, Qualifier.Series),
    variable('last_bar_index', IntType, Qualifier.Series),
    variable('time', IntType, Qualifier.Series),
    variable('timenow', IntType, Qualifier.Series),
    variable('math.pi', FloatType, Qualifier.Const, Math.PI),
    variable('math.e', FloatType, Qualifier.Const, Math.E),
    variable('syminfo.tickerid', StringType, Qualifier.Simple),
    variable('syminfo.ticker', StringType, Qualifier.Simple),
    variable('syminfo.prefix', StringType, Qualifier.Simple),
    variable('syminfo.currency', StringType, Qualifier.Simple),
    variable('syminfo.basecurrency', StringType, Qualifier.Simple),
    variable('syminfo.type', StringType, Qualifier.Simple),
    variable('syminfo.timezone', StringType, Qualifier.Simple),
    variable('syminfo.mintick', FloatType, Qualifier.Simple),
    variable('syminfo.pointvalue', FloatType, Qualifier.Simple),
    variable('timeframe.period', StringType, Qualifier.Simple),
    variable('timeframe.multiplier', IntType, Qualifier.Simple),
    variable('timeframe.isseconds', BoolType, Qualifier.Simple),
    variable('timeframe.isminutes', BoolType, Qualifier.Simple),
    variable('timeframe.isintraday', BoolType, Qualifier.Simple),
    variable('timeframe.isdaily', BoolType, Qualifier.Simple),
    variable('timeframe.isweekly', BoolType, Qualifier.Simple),
    variable('timeframe.ismonthly', BoolType, Qualifier.Simple),
    variable('timeframe.isdwm', BoolType, Qualifier.Simple),
  ];
  for (const name of SERIES_FLOAT_VARS) {
    vars.push(variable(name, FloatType, Qualifier.Series));
  }
  for (const name of BARSTATE_VARS) {
    vars.push(variable(name, BoolType, Qualifier.Series));
  }
  for (const [name, hex] of Object.entries(COLORS)) {
    vars.push(variable(`color.${name}`, ColorType, Qualifier.Const, hex));
  }
  for (const [prefix, members] of Object.entries(STRING_CONSTS)) {
    for (const member of members) {
      vars.push(
        variable(`${prefix}${member}`, StringType, Qualifier.Const, member),
      );
    }
  }
  return vars;
}

// ---- functions --------------------------------------------------------------

// Shared trailing params of the input.* family.
function inputTail(): NativeParam[] {
  return [
    opt('title', StringType, Qualifier.Const, {literal: true}),
    opt('tooltip', StringType, Qualifier.Const, {literal: true}),
    opt('inline', StringType, Qualifier.Const, {literal: true}),
    opt('group', StringType, Qualifier.Const, {literal: true}),
    opt('confirm', BoolType, Qualifier.Const, {literal: true}),
    opt('display', StringType, Qualifier.Const),
  ];
}

function numericInput(name: string, type: Type): NativeFunc {
  return func(
    name,
    [
      req('defval', type, Qualifier.Const, {literal: true}),
      opt('title', StringType, Qualifier.Const, {literal: true}),
      opt('minval', type, Qualifier.Const, {literal: true}),
      opt('maxval', type, Qualifier.Const, {literal: true}),
      opt('step', type, Qualifier.Const, {literal: true}),
      opt('tooltip', StringType, Qualifier.Const, {literal: true}),
      opt('inline', StringType, Qualifier.Const, {literal: true}),
      opt('group', StringType, Qualifier.Const, {literal: true}),
      opt('confirm', BoolType, Qualifier.Const, {literal: true}),
      opt('display', StringType, Qualifier.Const),
    ],
    type,
    Qualifier.Input,
    'param',
  );
}

function simpleInput(name: string, type: Type): NativeFunc {
  return func(
    name,
    [req('defval', type, Qualifier.Const, {literal: true}), ...inputTail()],
    type,
    Qualifier.Input,
    'param',
  );
}

// Numeric math native where int and float overloads share one result rule.
function mathNum(name: string, arity: number, result: 'same' | Type): NativeFunc[] {
  return [IntType, FloatType].map(t => {
    const params = Array.from({length: arity}, (_, i) =>
      req(i === 0 ? 'number' : `number${i}`, t, Qualifier.Series),
    );
    return func(`math.${name}`, params, result === 'same' ? t : result, 'join');
  });
}

function buildFuncs(): NativeFunc[] {
  const funcs: NativeFunc[] = [];

  // Script declaration.
  funcs.push(
    func(
      'indicator',
      [
        req('title', StringType, Qualifier.Const, {literal: true}),
        opt('shorttitle', StringType, Qualifier.Const, {literal: true}),
        opt('overlay', BoolType, Qualifier.Const, {literal: true}),
        opt('format', StringType, Qualifier.Const),
        opt('precision', IntType, Qualifier.Const, {literal: true}),
        opt('max_bars_back', IntType, Qualifier.Const, {literal: true}),
        opt('timeframe', StringType, Qualifier.Const),
        opt('timeframe_gaps', BoolType, Qualifier.Const, {literal: true}),
      ],
      VoidType,
      Qualifier.Const,
      'declaration',
    ),
  );

  // input.* — the param family: the checker extracts the declaration, the
  // runtime supplies the value at bind time. input.source's result is
  // series: the bound value is a per-bar stream, not a bind-time scalar.
  funcs.push(
    numericInput('input.int', IntType),
    numericInput('input.float', FloatType),
    simpleInput('input.bool', BoolType),
    simpleInput('input.string', StringType),
    simpleInput('input.color', ColorType),
    simpleInput('input.timeframe', StringType),
    simpleInput('input.symbol', StringType),
    func(
      'input.source',
      [req('defval', FloatType, Qualifier.Series), ...inputTail()],
      FloatType,
      Qualifier.Series,
      'param',
    ),
  );
  for (const t of [IntType, FloatType, BoolType, StringType, ColorType]) {
    funcs.push(
      func(
        'input',
        [req('defval', t, Qualifier.Const, {literal: true}), ...inputTail()],
        t,
        Qualifier.Input,
        'param',
      ),
    );
  }

  // Declarative outputs.
  funcs.push(
    func(
      'plot',
      [
        req('series', 'num', Qualifier.Series),
        opt('title', StringType, Qualifier.Const, {literal: true}),
        opt('color', ColorType, Qualifier.Series),
        opt('linewidth', IntType, Qualifier.Input),
        opt('style', StringType, Qualifier.Const),
        opt('trackprice', BoolType, Qualifier.Input),
        opt('histbase', FloatType, Qualifier.Const),
        opt('offset', IntType, Qualifier.Input),
        opt('editable', BoolType, Qualifier.Const),
        opt('show_last', IntType, Qualifier.Input),
        opt('display', StringType, Qualifier.Const),
        opt('format', StringType, Qualifier.Const),
        opt('precision', IntType, Qualifier.Const),
      ],
      PlotType,
      Qualifier.Const,
      'output',
    ),
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
      'output',
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
      'output',
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
      'output',
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
      'output',
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
      'output',
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
      'output',
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
        'output',
      ),
    );
  }

  // math.* — intrinsics only; aggregations over time (ta.*) are prelude.
  funcs.push(
    ...mathNum('abs', 1, 'same'),
    ...mathNum('sign', 1, 'same'),
    func('math.floor', [req('number', 'num', Qualifier.Series)], IntType, 'join'),
    func('math.ceil', [req('number', 'num', Qualifier.Series)], IntType, 'join'),
    func('math.round', [req('number', 'num', Qualifier.Series)], IntType, 'join'),
    func(
      'math.round',
      [
        req('number', 'num', Qualifier.Series),
        req('precision', IntType, Qualifier.Series),
      ],
      FloatType,
      'join',
    ),
    func(
      'math.sqrt',
      [req('number', 'num', Qualifier.Series)],
      FloatType,
      'join',
    ),
    func(
      'math.pow',
      [
        req('base', 'num', Qualifier.Series),
        req('exponent', 'num', Qualifier.Series),
      ],
      FloatType,
      'join',
    ),
    func('math.log', [req('number', 'num', Qualifier.Series)], FloatType, 'join'),
    func(
      'math.log10',
      [req('number', 'num', Qualifier.Series)],
      FloatType,
      'join',
    ),
    func('math.exp', [req('number', 'num', Qualifier.Series)], FloatType, 'join'),
    func(
      'math.avg',
      [req('number', 'num', Qualifier.Series, {variadic: true})],
      FloatType,
      'join',
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
        'join',
      ),
      func(
        name,
        [
          req('number', 'num', Qualifier.Series),
          req('number1', 'num', Qualifier.Series, {variadic: true}),
        ],
        FloatType,
        'join',
      ),
    );
  }

  // na handling and conversions.
  funcs.push(func('na', [req('x', 'any', Qualifier.Series)], BoolType, 'join'));
  for (const t of [IntType, FloatType, ColorType, StringType]) {
    funcs.push(
      func(
        'nz',
        [req('source', t, Qualifier.Series), opt('replacement', t, Qualifier.Series)],
        t,
        'join',
      ),
    );
  }
  funcs.push(
    func('fixnan', [req('source', FloatType, Qualifier.Series)], FloatType, 'join'),
    func('int', [req('x', 'num', Qualifier.Series)], IntType, 'join'),
    func('float', [req('x', 'num', Qualifier.Series)], FloatType, 'join'),
    func(
      'str.tostring',
      [req('value', 'any', Qualifier.Series)],
      StringType,
      'join',
    ),
    func(
      'color.new',
      [
        req('color', ColorType, Qualifier.Series),
        req('transp', 'num', Qualifier.Series),
      ],
      ColorType,
      'join',
    ),
    func(
      'color.rgb',
      [
        req('red', 'num', Qualifier.Series),
        req('green', 'num', Qualifier.Series),
        req('blue', 'num', Qualifier.Series),
        opt('transp', 'num', Qualifier.Series),
      ],
      ColorType,
      'join',
    ),
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
