/**
 *
 * Tea is a programming language for doing quantitative analysis and beyond. It is
 * inspired by the Pine Script language (https://www.tradingview.com/pine-script-reference/v6/)
 * but is designed to be more general and flexible. For example, it supports
 * native cross-sectional analysis, has native support for LLMs as well as
 * third-party broker/backtest libraries and APIs.
 *
 * Unlike general purpose programming languages like C++ or Javascript, Tea
 * is not compiled to native code nor can be interpreted directly without its
 * runtime. Instead, Tea code is first compiled to an intermediate representation (IR),
 * which then gets lowered to the language of the runtime (currently Javascript).
 * The Tea runtime then instantiates the compiled script as an executable and provides
 * it with the necessary data and context to run.
 *
 * To illustrate the idea, consider the following example.
 * ___________________________________
 *  indicator("my_indicator")
 *  const model = "gpt-3.5-turbo"
 *  var my_var = close + open
 *  red = input.color(#ff0000)
 *  green = input.color(#00ff00)
 *  if my_var > my_var[1]
 *      color = green
 *  else
 *      color = red
 *  plot("my_plot", my_var, color)
 *  var resp = llm(model, "What is the current trend of the market given my_var=$my_var?", ["up", "down"])
 *  if resp == "up"
 *      label((bar_index, high), "The market is trending up!", color=green)
 *  else
 *      label((bar_index, low), "The market is trending down!", color=red)
 * ___________________________________
 *
 * The above script computes the sum of the close and open price of a security, and
 * conditionally colors the plot based on whether the sum is greater than its previous value.
 * It also uses an LLM to determine the trend of the market based on the computed value and adds a
 * label to the chart accordingly.
 *
 * We'll discuss more about the IR in a bit, but for now it suffices to understand
 * that the above script is compiled to a Tea program, which has roughly the following interface:
 *
 * interface Program {
 *     inputs: Input[];    // Inputs to the program, include both data series and user inputs
 *     statements: Statement[];   // Top level IR statements of the program
 *     outputs: Output[];  // Outputs of the program, include statically known outputs like plots and hlines
 *     // imports: Import[];      Not implemented yet, contains imports of other Tea packages
 * }
 *
 * Essentially, a program contains all the information that can be statically known about the script.
 * To run the program, the runtime needs to instantiate a Runnable from the program by
 * 1. Binding the program to actual inputs
 * 2. Lowering the program an executable form (currently Javascript)
 *
 * So the overall Tea runtime flow looks as follows:
 *
 * Compilation -> Binding -> Lowering -> Execution
 *
 *
 */

type Code = string;

interface ArrayLike<T> {
  readonly length: number;
  readonly [n: number]: T;
}

interface SourceFile {}

enum ParamType {
  float = 1,
  int,
  bool,
  string,
  color,
}

interface ParamDecl {
  readonly kind: 'param';
  type: ParamType;
}

interface SeriesDecl {
  readonly kind: 'series';
  series: DataSeries;
}

type InputDecl = ParamDecl | SeriesDecl;

interface Program {
  readonly languageVersion: number;
  readonly abiVersion: number;

  inputs: Record<string, InputDecl>;
  statements: Statement[];
  outputs: Output[];
}

interface Runnable {
  step(): void;
}

interface Compiler {
  compile(code: Code, options?: CompileOptions): Program;

  lower(runtime: Runtime, program: Program, options?: LowerOptions): Runnable;
}

interface Runtime {
  readonly abiVersion: number;

  bind(program: Program, inputs: Input[], options?: BindOptions): Promise<void>;
  instantiate(
    program: Program,
    options?: InstantiateOptions,
  ): Promise<Runnable>;
  run(runnable: Runnable, options?: RunOptions): Promise<void>; // contains the main loop
}
