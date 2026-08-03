# TEA language

Tea is a programming language for doing quantitative analysis and beyond. It is inspired by the Pine Script language (https://www.tradingview.com/pine-script-reference/v6/) but is designed to be more general and flexible. For example, it supports native cross-sectional analysis, has native support for LLMs as well as third-party broker/backtest libraries and APIs.

The most canonical usage of Tea is to perform transformations on time series and generate side effects from it. Consider the following example:

```
// my_indicator.tea
var my_var = close + open
if my_var > my_var[1]
    color = colors.green
else
    color = colors.red
plot("my_plot", my_var, color)
```

and the following dataset

```
$> cat dataset.csv

| open  | close |
|---------------|
| 1.0   |  1.3  |
| 1.2   |  1.5  |
| 1.4   |  1.2  |
```

Running the tea script would give the following output

```
$> tea run my_indicator.tea -i dataset.csv

| my_plot | color  |
|------------------|
| 2.3     |        |
| 2.7     |  green |
| 2.6     |  red   |
```

## Why is

## Execution Model

The execution model can be conceptually understood as a **for loop** that runs the script over and over again for a given dataset, row by row. That means the script only defines the inner loop of the

## Memory Model

## Compilation and IR

Unlike general purpose programming languages like C++ or Javascript, Tea is not compiled to native code nor can be interpreted directly without its runtime. Instead, Tea code is first compiled to an intermediate representation (IR), which then gets lowered to the language of the runtime (currently Javascript). The Tea runtime then instantiates the compiled script as an executable and provides it with the necessary data and context to run.

This do
