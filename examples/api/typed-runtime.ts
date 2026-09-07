// Handwritten runtime example, equivalent to typed-runtime.tea; not compiler output.
// Run after `npm run build:package`: node examples/api/typed-runtime.ts
import {Field, Float64, Schema} from 'apache-arrow';
import {from} from 'rxjs';
import {createNode, DataStream} from 'tea';
import {
  type Context,
  type Input,
  Module,
  RUNTIME_ABI_VERSION,
  type Series,
  type Value,
  float,
  outputSchema,
} from 'tea/runtime';

type Sum = {locals: {total: Series<number, 'float'>}; calls: {}};
type Program = Context<
  {lag: Value<number, 'int'>},
  {series: {close: Input<number, 'float'>; open: Input<number, 'float'>}},
  {locals: {}; calls: {close: Sum; open: Sum}},
  {
    output0: {set(value: Value<number, 'float'>): void};
    output1: {set(value: Value<number, 'float'>): void};
    output2: {set(value: Value<number, 'float'>): void};
  }
>;

function accumulate(frame: Sum, value: Value<number, 'float'>) {
  const total = frame.locals.total;
  total.init(() => float(0));
  total.set(total.hist(0).add(value));
  return total.hist(0);
}

function main(ctx: Program): void {
  const close = ctx.inputs.series.close.hist(0);
  const open = ctx.inputs.series.open.hist(0);
  const state = ctx.state;
  ctx.outputs.output0.set(accumulate(state.calls.close, close));
  ctx.outputs.output1.set(accumulate(state.calls.open, open));
  ctx.outputs.output2.set(ctx.inputs.series.close.hist(ctx.params.lag));
}

const schema = new Schema([
  new Field('close', new Float64(), false),
  new Field('open', new Float64(), false),
]);

// The same Arrow schemas and storage requirements the compiler would emit.
export const program = new Module<Program>(
  {
    abi: RUNTIME_ABI_VERSION,
    inputs: {
      schema,
      series: [
        {name: 'close', id: 'close', depth: {kind: 'bound'}},
        {name: 'open', id: 'open', depth: {kind: 'none'}},
      ],
      builtins: [],
    },
    parameters: [
      {
        name: 'lag',
        type: 'int',
        control: 'input.int',
        defaultValue: 1,
        constraints: {kind: 'range', minval: 0, maxval: 10, step: 1},
        active: true,
        title: null,
        enumType: null,
        group: null,
        inline: null,
        tooltip: null,
        confirm: false,
        display: 'all',
        seriesSid: null,
      },
    ],
    state: {
      frames: [
        {
          locals: [],
          subs: [
            {name: 'close', fid: 1},
            {name: 'open', fid: 1},
          ],
        },
        {
          locals: [
            {
              name: 'total',
              storage: 'var',
              depth: {kind: 'none'},
              empty: float(NaN),
            },
          ],
          subs: [],
        },
      ],
    },
    outputs: {
      schema: outputSchema(
        ['output0', 'output1', 'output2'].map(
          name =>
            new Field(
              name,
              new Float64(),
              true,
              new Map([
                ['tea:write', 'set'],
                ['tea:type', 'float'],
              ]),
            ),
        ),
      ),
    },
    requests: [],
  },
  main,
  data => {
    data.inputs.series[0].depth = {
      kind: 'const',
      bars: data.parameters[0].value as number,
    };
  },
);

// Binding owns configuration; Node owns streams, child synchronization and stepping.
const node = createNode(program.bind({lag: 1}));
node.bind(
  new DataStream(
    schema,
    from([
      {close: 10, open: 1},
      {close: 20, open: 2},
      {close: 30, open: 3},
    ]),
  ),
);
node.to({next: datum => console.log(datum)});
// Close sum: 10, 30, 60. Open sum: 1, 3, 6. Previous close: NaN, 10, 20.
