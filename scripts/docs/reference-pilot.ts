// Purpose: Human-written metadata for generated Tea reference pages and their information architecture.

export const REFERENCE_CATEGORIES = [
  'types',
  'variables',
  'constants',
  'functions',
  'keywords',
  'operators',
  'annotations',
] as const;

export type ReferenceCategory = (typeof REFERENCE_CATEGORIES)[number];

export interface ReferenceExample {
  readonly title: string;
  readonly explanation: string;
  readonly source: string;
}

export interface ReferenceLink {
  readonly label: string;
  readonly href: string;
}

interface EntryBase {
  readonly id: string;
  readonly category: ReferenceCategory;
  readonly title: string;
  readonly route: string;
  readonly summary: string;
  readonly description: readonly string[];
  readonly examples: readonly ReferenceExample[];
  readonly remarks: readonly string[];
  readonly seeAlso: readonly ReferenceLink[];
}

export interface TypeEntry extends EntryBase {
  readonly kind: 'type';
  readonly compilerName: string;
  readonly syntax: readonly string[];
  readonly typeParameters: readonly {
    readonly name: string;
    readonly description: string;
  }[];
  readonly construction: readonly ReferenceLink[];
  readonly operations: readonly ReferenceLink[];
}

export interface VariableEntry extends EntryBase {
  readonly kind: 'variable';
  readonly compilerName: string;
  readonly qualifiedType: string;
}

export interface ConstantEntry extends EntryBase {
  readonly kind: 'constant';
  readonly compilerName: string;
  readonly type: string;
  readonly value: string;
}

export interface FunctionEntry extends EntryBase {
  readonly kind: 'function';
  readonly compilerName: string;
  readonly arguments: Readonly<Record<string, string>>;
  readonly returns: string;
  readonly runtimeErrors: readonly string[];
}

export interface KeywordEntry extends EntryBase {
  readonly kind: 'keyword';
  readonly compilerKeywords: readonly string[];
  readonly syntax: readonly string[];
  readonly parts: readonly {
    readonly name: string;
    readonly type: string;
    readonly description: string;
  }[];
  readonly typeRelationships: readonly {
    readonly collection: string;
    readonly form: string;
    readonly bindings: string;
    readonly bindingTypes: string;
  }[];
  readonly behaviorSections: readonly {
    readonly title: string;
    readonly paragraphs: readonly string[];
  }[];
}

export interface OperatorEntry extends EntryBase {
  readonly kind: 'operator';
  readonly syntax: readonly string[];
  readonly operands: readonly {
    readonly name: string;
    readonly type: string;
    readonly description: string;
  }[];
  readonly returns: string;
}

export interface AnnotationEntry extends EntryBase {
  readonly kind: 'annotation';
  readonly syntax: readonly string[];
  readonly placement: string;
  readonly effect: string;
}

export type ReferenceEntry =
  | TypeEntry
  | VariableEntry
  | ConstantEntry
  | FunctionEntry
  | KeywordEntry
  | OperatorEntry
  | AnnotationEntry;

function lines(...source: string[]): string {
  return source.join('\n');
}

export const REFERENCE_CATEGORY_SUMMARIES: Readonly<
  Record<ReferenceCategory, string>
> = {
  types:
    'Value shapes that determine which operations a Tea expression supports.',
  variables: 'Values supplied by the current data and execution context.',
  constants:
    'Named values established before execution and reused in expressions and function calls.',
  functions:
    'Built-in operations provided by Tea, grouped by purpose and namespace.',
  keywords:
    'Words and compound forms that introduce declarations, control flow, and other language constructs.',
  operators:
    'Symbols and words that combine, update, select, or retrieve values.',
  annotations: 'Source comments with a defined meaning to the Tea compiler.',
};

export const PILOT_REFERENCE_ENTRIES: readonly ReferenceEntry[] = [
  {
    kind: 'type',
    id: 'array',
    category: 'types',
    compilerName: 'array',
    title: 'array',
    route: '/reference/types/array/',
    summary:
      'An array is an ordered, variable-length collection whose elements all have one type.',
    syntax: ['array<Element>', 'Element[]'],
    typeParameters: [
      {
        name: 'Element',
        description:
          'The type stored at every position. It must be a storable Tea type.',
      },
    ],
    description: [
      'Array positions start at zero. Use array functions or their method form to create, read, and update an array.',
      'Assigning an array gives the destination its current collection value. A later update to one variable or struct field does not rewrite values assigned elsewhere or committed to earlier history.',
      'An array can contain struct references. When two arrays contain the same struct, changing that struct is visible through both arrays.',
    ],
    construction: [
      {label: 'array.new()', href: '/reference/functions/'},
      {label: 'array.from()', href: '/reference/functions/'},
    ],
    operations: [
      {label: 'array.push()', href: '/reference/functions/array/push/'},
      {label: 'for...in', href: '/reference/keywords/for-in/'},
      {label: 'History operator []', href: '/reference/operators/history/'},
    ],
    examples: [
      {
        title: 'Preserving an earlier array value',
        explanation:
          '`earlier` keeps the two-element value it received. Updating `values` does not rewrite it.',
        source: lines(
          'values = array.from(10, 20)',
          'earlier = values',
          'values.push(30)',
          '',
          'plot(earlier.size()) // 2',
          'plot(values.size())  // 3',
        ),
      },
      {
        title: 'Sharing a contained struct',
        explanation:
          'Collection values are preserved independently, but contained structs remain references.',
        source: lines(
          'struct Point',
          '    int x',
          '',
          'point = Point.new(1)',
          'left = array.from(point)',
          'right = array.from(point)',
          '',
          'point.x := 2',
          'plot(left.get(0).x)  // 2',
          'plot(right.get(0).x) // 2',
        ),
      },
    ],
    remarks: [
      "`array.new<Element>(size)` fills each position with the element type's empty value. Supply an initial value as the second argument when another value is required.",
      'An array update requires a writable variable or struct field. A temporary array or an array read through history is not a writable target.',
      'Reading outside the current array bounds stops the current execution with a runtime error.',
    ],
    seeAlso: [
      {label: 'array.push()', href: '/reference/functions/array/push/'},
      {label: 'for...in', href: '/reference/keywords/for-in/'},
      {label: 'History operator []', href: '/reference/operators/history/'},
    ],
  },
  {
    kind: 'variable',
    id: 'close',
    category: 'variables',
    compilerName: 'close',
    title: 'close',
    route: '/reference/variables/close/',
    summary:
      '`close` is the closing price supplied for the current row in the active data context.',
    qualifiedType: 'series float',
    description: [
      'The primary data provider supplies `close` once for every execution row. Inside a requested context, it refers to that requested symbol and timeframe instead.',
      'Because `close` is a series value, its value may differ on every row and its earlier values are available through the history operator.',
    ],
    examples: [
      {
        title: 'Plotting one-row price change',
        explanation:
          'The first row has no earlier close, so `nz()` substitutes the current close and produces a zero change.',
        source: lines(
          'previous = nz(close[1], close)',
          'change = close - previous',
          'plot(change)',
        ),
      },
    ],
    remarks: [
      '`close` can be `na` when the provider has no close value for a row.',
      '`close[1]` reads the previous committed row. It returns the float empty value when no such row is available.',
      'The meaning of a row—bar, quote, trade, or another event shape—is determined by the provider contract used for that execution.',
    ],
    seeAlso: [
      {label: 'History operator []', href: '/reference/operators/history/'},
      {label: 'Variables', href: '/reference/variables/'},
    ],
  },
  {
    kind: 'constant',
    id: 'color-red',
    category: 'constants',
    compilerName: 'color.red',
    title: 'color.red',
    route: '/reference/constants/color/red/',
    summary: '`color.red` is Tea’s standard red color constant.',
    type: 'const color',
    value: '#FF5252',
    description: [
      'Use `color.red` wherever a function accepts a color. It is established at compile time and does not change between rows.',
    ],
    examples: [
      {
        title: 'Highlighting falling closes',
        explanation:
          'The plot is red when the current close is below the previous close and green otherwise.',
        source: lines(
          'falling = close < close[1]',
          'lineColor = falling ? color.red : color.green',
          'plot(close, color=lineColor)',
        ),
      },
    ],
    remarks: [
      'Use `color.new(color.red, transparency)` to derive a transparent form.',
      'Tea owns this palette value; it does not depend on the host application’s theme.',
    ],
    seeAlso: [
      {label: 'Constants', href: '/reference/constants/'},
      {label: 'Functions', href: '/reference/functions/'},
    ],
  },
  {
    kind: 'function',
    id: 'array-push',
    category: 'functions',
    compilerName: 'array.push',
    title: 'array.push()',
    route: '/reference/functions/array/push/',
    summary: '`array.push()` appends one element to an array.',
    arguments: {
      self: 'The array to update. It must be held by a writable variable or struct field.',
      value:
        'The element to append. Its type must match the array element type.',
    },
    returns: 'No value.',
    description: [
      'The function writes the updated array value back to its receiver. The namespace call and method call below have the same behavior.',
    ],
    examples: [
      {
        title: 'Appending the current close',
        explanation:
          'The array stored in `var` grows by one element on every execution row.',
        source: lines(
          'var values = array.new<float>()',
          'values.push(close)',
          'plot(values.size())',
        ),
      },
      {
        title: 'Calling through the array namespace',
        explanation:
          'Use the namespace spelling when an explicit function call is clearer.',
        source: lines(
          'values = array.from(1, 2)',
          'array.push(values, 3)',
          'plot(values.last()) // 3',
        ),
      },
    ],
    remarks: [
      'Appending to one array variable does not rewrite an earlier array value assigned to another variable or committed to history.',
      'If the element is a struct, the array stores its reference rather than copying the struct body.',
    ],
    runtimeErrors: [
      'The receiver is `na`.',
      'Appending would exceed an execution collection or memory limit.',
    ],
    seeAlso: [
      {label: 'array', href: '/reference/types/array/'},
      {label: 'for...in', href: '/reference/keywords/for-in/'},
    ],
  },
  {
    kind: 'keyword',
    id: 'for-in',
    category: 'keywords',
    compilerKeywords: ['for', 'in'],
    title: 'for...in',
    route: '/reference/keywords/for-in/',
    summary:
      '`for...in` creates a collection-controlled loop that visits each element of an array or each key-value pair of a map.',
    syntax: [
      '[result = | result :=] for element in array\n    statements | continue | break\n    return_expression',
      '[result = | result :=] for [index, element] in array\n    statements | continue | break\n    return_expression',
      '[result = | result :=] for [key, value] in map\n    statements | continue | break\n    return_expression',
    ],
    parts: [
      {
        name: 'result',
        type: 'series Result',
        description:
          'Optional. A new variable declared with `=`, or an existing writable target updated with `:=`, that receives the loop’s final result. A tuple declaration can receive a tuple-valued result.',
      },
      {
        name: 'element',
        type: 'series Element',
        description:
          'A local variable containing the current array element. Reassigning this variable does not replace the element stored in the array.',
      },
      {
        name: 'index',
        type: 'series int',
        description:
          'The zero-based position of the current array element. It is available only in the array tuple form.',
      },
      {
        name: 'key',
        type: 'series Key',
        description:
          'The current map key. Direct map iteration requires the `[key, value]` tuple form.',
      },
      {
        name: 'value',
        type: 'series Value',
        description:
          'A local variable containing the value associated with the current map key.',
      },
      {
        name: 'array',
        type: 'array<Element>',
        description:
          'The array value whose elements the loop visits from index zero upward.',
      },
      {
        name: 'map',
        type: 'map<Key, Value>',
        description:
          'The map value whose key-value pairs the loop visits in insertion order.',
      },
      {
        name: 'statements',
        type: 'source statements',
        description:
          'The indented block executed for each visited item. Each declaration and expression is checked normally inside the loop’s local scope.',
      },
      {
        name: 'return_expression',
        type: 'Result',
        description:
          'The final value-producing expression in the loop body. After the loop terminates, the loop result is the latest value this expression produced.',
      },
    ],
    typeRelationships: [
      {
        collection: 'array<Element>',
        form: 'for element in array',
        bindings: 'element',
        bindingTypes: 'series Element',
      },
      {
        collection: 'array<Element>',
        form: 'for [index, element] in array',
        bindings: 'index, element',
        bindingTypes: 'series int, series Element',
      },
      {
        collection: 'map<Key, Value>',
        form: 'for [key, value] in map',
        bindings: 'key, value',
        bindingTypes: 'series Key, series Value',
      },
    ],
    description: [
      '`Element`, `Key`, `Value`, and `Result` are type variables: their concrete types come from the collection and the loop body in the program being checked.',
    ],
    behaviorSections: [
      {
        title: 'Iteration order and collection capture',
        paragraphs: [
          'Tea evaluates the collection expression once when the loop begins and visits that captured collection value. Arrays advance from index zero to the last captured element. Maps visit key-value pairs in insertion order.',
          'Updating the source collection variable inside the body does not add, remove, or reorder iterations in the loop already in progress.',
        ],
      },
      {
        title: 'Loop result',
        paragraphs: [
          'A `for...in` loop is an expression. Its type is the type of `return_expression`, promoted to the `series` qualifier because the value depends on iteration.',
          'The result is the latest value produced by `return_expression`. If no iteration produces that expression, the loop returns the `Result` type’s empty value. A `continue` skips the remaining body, including the return expression; a `break` exits while preserving the latest result produced by an earlier completed iteration.',
        ],
      },
      {
        title: 'Local bindings and updates',
        paragraphs: [
          'The loop bindings belong to the loop’s local scope. Tea permits reassignment of these local variables, but that reassignment does not update the corresponding array element or map entry. Use a collection update function when the collection itself must change.',
        ],
      },
    ],
    examples: [
      {
        title: 'Returning the last computed value',
        explanation:
          'The final expression produces an `int` on every iteration, so the loop has type `series int` and returns the final square.',
        source: lines(
          'values = array.from(3, 5, 8)',
          '',
          'lastSquare = for element in values',
          '    element * element',
          '',
          'plot(lastSquare) // 64',
        ),
      },
      {
        title: 'Using an array index and element',
        explanation:
          'For `array<int>`, the tuple form binds `index` as `series int` and `element` as `series int`.',
        source: lines(
          'values = array.from(2, 4, 6)',
          'weighted = 0',
          '',
          'for [index, element] in values',
          '    weighted += index * element',
          '',
          'plot(weighted) // 16',
        ),
      },
      {
        title: 'Visiting map entries in insertion order',
        explanation:
          'A map loop requires a two-name target containing the key and value.',
        source: lines(
          'values = map.new<string, int>()',
          'values.put("left", 2)',
          'values.put("right", 3)',
          'total = 0',
          '',
          'for [key, value] in values',
          '    total += value',
          '',
          'plot(total) // 5',
        ),
      },
      {
        title: 'Updating the source during iteration',
        explanation:
          'The loop captured the original two-element array, so the appended values do not create additional iterations.',
        source: lines(
          'values = array.from(1, 2)',
          'visited = 0',
          '',
          'for element in values',
          '    visited += 1',
          '    values.push(element + 10)',
          '',
          'plot(visited)       // 2',
          'plot(values.size()) // 4',
        ),
      },
    ],
    remarks: [
      'Array loops accept either `element` or `[index, element]`. Map loops require `[key, value]`.',
      'Matrix iteration is not part of this construct. Use matrix operations such as `rows()`, `columns()`, and `get()`.',
      'A loop whose body has no value-producing final expression has type `void` and cannot initialize a result variable.',
    ],
    seeAlso: [
      {label: 'array', href: '/reference/types/array/'},
      {label: 'array.push()', href: '/reference/functions/array/push/'},
    ],
  },
  {
    kind: 'operator',
    id: 'history',
    category: 'operators',
    title: 'History operator []',
    route: '/reference/operators/history/',
    summary:
      'The history operator reads a value committed by the same variable on an earlier execution row.',
    syntax: ['variable[offset]', '(variable)[offset]'],
    operands: [
      {
        name: 'variable',
        type: 'series T',
        description:
          'A directly readable runtime variable or built-in value. Calls, arithmetic expressions, and field selections are not valid history operands.',
      },
      {
        name: 'offset',
        type: 'int',
        description:
          'An `int` expression. Zero selects the current committed value; one selects the previous row.',
      },
    ],
    returns:
      'The same type as `variable`. An unavailable or invalid offset produces that type’s empty value.',
    description: [
      'Tea stores committed values for variables that are read through history. The offset counts execution rows backward from the current row.',
      'History applies to the variable before later selection. For example, `point[1].x` is valid, while `point.x[1]` is not.',
    ],
    examples: [
      {
        title: 'Comparing the current and previous close',
        explanation:
          '`nz()` supplies the current close when the previous row is unavailable.',
        source: lines(
          'previous = nz(close[1], close)',
          'rising = close > previous',
          'plot(rising ? 1 : 0)',
        ),
      },
      {
        title: 'Reading historical collection contents',
        explanation:
          'The array read through history keeps the contents committed for that earlier row.',
        source: lines(
          'var values = array.new<int>()',
          'previous = values[1]',
          'values.push(bar_index)',
          'plot(na(previous) ? 0 : previous.size())',
        ),
      },
    ],
    remarks: [
      'Negative, non-finite, non-integer, `na`, and out-of-range offsets produce the result type’s empty value.',
      'History of a struct variable stores the earlier struct reference. It does not freeze or copy the object’s fields.',
      'History of a collection variable preserves that earlier collection value. Structs contained by the collection remain references.',
    ],
    seeAlso: [
      {label: 'close', href: '/reference/variables/close/'},
      {label: 'array', href: '/reference/types/array/'},
    ],
  },
  {
    kind: 'annotation',
    id: 'version',
    category: 'annotations',
    title: '//@version',
    route: '/reference/annotations/version/',
    summary:
      '`//@version` records the Tea language version declared by a source file.',
    syntax: ['//@version=1'],
    placement:
      'Write the annotation as a line comment, conventionally on the first line. If it appears more than once, the first value wins.',
    effect:
      'The declared number is stored on the compiled program and inherited by request child programs. A file without the annotation defaults to version 1.',
    description: [
      'Use version 1 for current Tea source. Other values are recorded as metadata but do not select another grammar or execution dialect yet.',
    ],
    examples: [
      {
        title: 'Declaring Tea version 1',
        explanation: 'The annotation applies to the complete source file.',
        source: lines(
          '//@version=1',
          '',
          'indicator("Versioned source")',
          'plot(close)',
        ),
      },
    ],
    remarks: [
      'Whitespace around `=` is accepted, but the compact form is preferred.',
      'The annotation is still a comment; it does not produce a runtime value.',
    ],
    seeAlso: [{label: 'Reference overview', href: '/reference/overview/'}],
  },
];
