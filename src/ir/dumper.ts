// Purpose: Human-readable Program dumps behind `tea parse --ir` and the IR goldens — formatting only, no semantic logic; shared declaration objects print as stable labels.

import {fatal} from '../base/print';
import {
  DepthKind,
  IrKind,
  PlaceKind,
  type HistoryDepth,
  type IrExpr,
  type IrStmt,
  type Name,
  type Place,
} from './node';
import {
  ParamDefaultKind,
  type OutputDecl,
  type Program,
  type RequestEdge,
} from './program';
import {formatType, isNaValue, type ConstValue} from './type';
import {
  funcsOf,
  namesOf,
  requestsOf,
  seriesInputsOf,
  slotCountOf,
} from './visit';

// Labels: names keep their source spelling, suffixed #i only on collision;
// outputs and requests are indexed by their Program order.
class Labels {
  private readonly names = new Map<Name, string>();
  private readonly outputs = new Map<OutputDecl, number>();
  private readonly requests = new Map<RequestEdge, number>();

  constructor(program: Program) {
    const seen = new Map<string, number>();
    for (const name of namesOf(program)) {
      const count = seen.get(name.name) ?? 0;
      seen.set(name.name, count + 1);
      this.names.set(name, count === 0 ? name.name : `${name.name}#${count}`);
    }
    program.outputs.forEach((output, i) => this.outputs.set(output, i));
    requestsOf(program).forEach((request, i) => this.requests.set(request, i));
  }

  name(name: Name): string {
    return this.names.get(name) ?? `${name.name}#?`;
  }

  output(output: OutputDecl): string {
    return `output[${this.outputs.get(output) ?? '?'}]`;
  }

  request(request: RequestEdge): string {
    return `request[${this.requests.get(request) ?? '?'}]`;
  }
}

function formatValue(value: ConstValue): string {
  if (isNaValue(value)) {
    return 'na';
  }
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

export function dumpProgram(program: Program): string {
  const labels = new Labels(program);
  const out: string[] = [];
  const slots = slotCountOf(program);
  out.push(
    `Program version=${program.version}${slots > 0 ? ` slots=${slots}` : ''}`,
  );

  for (const param of program.params) {
    let line = `param ${param.name}: ${formatType(param.type)}`;
    if (param.title !== null) {
      line += ` title=${JSON.stringify(param.title)}`;
    }
    if (param.defaultValue !== null) {
      line +=
        param.defaultValue.kind === ParamDefaultKind.Const
          ? ` default=${formatValue(param.defaultValue.value)}`
          : ` default=series(${param.defaultValue.series.id})`;
    }
    const c = param.constraints;
    if (c !== null) {
      const parts: string[] = [];
      if (c.minval !== null) {
        parts.push(`min=${formatValue(c.minval)}`);
      }
      if (c.maxval !== null) {
        parts.push(`max=${formatValue(c.maxval)}`);
      }
      if (c.step !== null) {
        parts.push(`step=${formatValue(c.step)}`);
      }
      line += ` {${parts.join(' ')}}`;
    }
    dumpDepthLine(line, param.depth, '', out, labels);
  }

  for (const series of seriesInputsOf(program)) {
    const line = `series ${series.id}: ${series.qualifier} ${formatType(series.type)}`;
    dumpDepthLine(line, series.depth, '', out, labels);
  }

  program.outputs.forEach((output, i) => {
    const statics = output.staticArgs
      .map(a => `${a.name}=${formatValue(a.value)}`)
      .join(' ');
    const channels = output.channels
      .map(ch => `${ch.name}: ${formatType(ch.type)}`)
      .join(', ');
    out.push(
      `output[${i}] ${output.effect}` +
        (statics.length > 0 ? ` static{${statics}}` : '') +
        (channels.length > 0 ? ` channels{${channels}}` : ''),
    );
    for (const bind of output.bindArgs) {
      dumpExpr(bind.expr, `bind ${bind.name}: `, '  ', out, labels);
    }
  });

  requestsOf(program).forEach((edge, i) => {
    const m = edge.merge;
    const flags = [
      `mode=${m.mode}`,
      m.gaps ? 'gaps' : null,
      m.lookahead ? 'lookahead' : null,
      m.ignoreInvalidSymbol ? 'ignore_invalid' : null,
      m.currency !== null ? `currency=${m.currency}` : null,
      `result=${formatType(edge.resultType)}`,
    ]
      .filter(part => part !== null)
      .join(' ');
    dumpDepthLine(`request[${i}] ${flags}`, edge.depth, '', out, labels);
    dumpExpr(edge.symbol, 'symbol: ', '  ', out, labels);
    dumpExpr(edge.timeframe, 'timeframe: ', '  ', out, labels);
    if (m.calcBarsCount !== null) {
      dumpExpr(m.calcBarsCount, 'calc_bars_count: ', '  ', out, labels);
    }
    // The child is a full Program with its own label space.
    out.push('  child:');
    for (const line of dumpProgram(edge.child).split('\n')) {
      out.push(`    ${line}`);
    }
  });

  for (const name of namesOf(program)) {
    const line =
      `name ${labels.name(name)}: ${name.storage} ${name.qualifier} ` +
      formatType(name.type);
    dumpDepthLine(line, name.depth, '', out, labels);
    if (name.init !== null) {
      dumpExpr(name.init, 'init: ', '  ', out, labels);
    }
  }

  for (const func of funcsOf(program)) {
    const params = func.params
      .map(p => `${labels.name(p)}: ${p.qualifier} ${formatType(p.type)}`)
      .join(', ');
    out.push(
      `func ${func.name}(${params}): ${func.resultQualifier} ${formatType(func.resultType)}`,
    );
    dumpExpr(func.body, 'body: ', '  ', out, labels);
  }

  if (program.body.length > 0) {
    out.push('body:');
    for (const stmt of program.body) {
      dumpStmt(stmt, '', '  ', out, labels);
    }
  }
  return out.join('\n');
}

// `<line> depth=<...>`, with bound/capped depth expressions as children.
function dumpDepthLine(
  line: string,
  depth: HistoryDepth,
  indent: string,
  out: string[],
  labels: Labels,
): void {
  switch (depth.kind) {
    case DepthKind.None:
      out.push(`${indent}${line} depth=none`);
      return;
    case DepthKind.Const:
      out.push(`${indent}${line} depth=const(${depth.bars})`);
      return;
    case DepthKind.Bound:
      out.push(`${indent}${line} depth=bound`);
      dumpExpr(depth.expr, 'depth.expr: ', `${indent}  `, out, labels);
      return;
    case DepthKind.Capped:
      out.push(`${indent}${line} depth=capped`);
      dumpExpr(depth.bars, 'depth.cap: ', `${indent}  `, out, labels);
      return;
  }
}

function placeLabel(place: Place, labels: Labels): string {
  switch (place.kind) {
    case PlaceKind.Name:
      return `name:${labels.name(place.name)}`;
    case PlaceKind.Param:
      return `param:${place.param.name}`;
    case PlaceKind.Series:
      return `series:${place.series.id}`;
    case PlaceKind.Request:
      return labels.request(place.request);
  }
}

function dumpStmt(
  stmt: IrStmt,
  label: string,
  indent: string,
  out: string[],
  labels: Labels,
): void {
  switch (stmt.kind) {
    case IrKind.ExprStmt:
      out.push(`${indent}${label}ExprStmt`);
      dumpExpr(stmt.x, '', `${indent}  `, out, labels);
      return;
    case IrKind.WriteName:
      out.push(`${indent}${label}WriteName ${labels.name(stmt.name)}`);
      dumpExpr(stmt.value, '', `${indent}  `, out, labels);
      return;
    case IrKind.WriteField:
      out.push(`${indent}${label}WriteField .${stmt.field}`);
      dumpExpr(stmt.x, 'x: ', `${indent}  `, out, labels);
      dumpExpr(stmt.value, 'value: ', `${indent}  `, out, labels);
      return;
    case IrKind.Emit:
      out.push(`${indent}${label}Emit ${labels.output(stmt.output)}`);
      for (const arg of stmt.args) {
        dumpExpr(arg, '', `${indent}  `, out, labels);
      }
      return;
    case IrKind.Break:
      out.push(`${indent}${label}Break`);
      return;
    case IrKind.Continue:
      out.push(`${indent}${label}Continue`);
      return;
    default:
      return fatal(`unhandled IR statement in dump: ${JSON.stringify(stmt)}`);
  }
}

function dumpExpr(
  expr: IrExpr,
  label: string,
  indent: string,
  out: string[],
  labels: Labels,
): void {
  const sig = `: ${expr.qualifier} ${formatType(expr.type)}`;
  const line = (detail: string): void => {
    out.push(`${indent}${label}${expr.kind}${detail}${sig}`);
  };
  const child = (e: IrExpr, l = ''): void => {
    dumpExpr(e, l, `${indent}  `, out, labels);
  };
  switch (expr.kind) {
    case IrKind.Const:
      line(` ${formatValue(expr.value)}`);
      return;
    case IrKind.OutputRef:
      line(` ${labels.output(expr.output)}`);
      return;
    case IrKind.HistRead:
      line(` ${placeLabel(expr.place, labels)}`);
      if (expr.offset !== null) {
        child(expr.offset, 'offset: ');
      }
      return;
    case IrKind.Binary:
      line(` ${expr.op}`);
      child(expr.x);
      child(expr.y);
      return;
    case IrKind.Unary:
      line(` ${expr.op}`);
      child(expr.x);
      return;
    case IrKind.Cond:
      line('');
      child(expr.cond, 'cond: ');
      child(expr.then, 'then: ');
      child(expr.else, 'else: ');
      return;
    case IrKind.CallFunc:
      line(` ${expr.func.name} slot=${expr.slot}`);
      for (const arg of expr.args) {
        child(arg);
      }
      return;
    case IrKind.CallNative:
      line(` ${expr.native}${expr.slot !== null ? ` slot=${expr.slot}` : ''}`);
      for (const arg of expr.args) {
        child(arg);
      }
      return;
    case IrKind.NewUdt:
      line(` ${expr.udt.name}`);
      for (const arg of expr.args) {
        child(arg);
      }
      return;
    case IrKind.MakeTuple:
      line('');
      for (const elem of expr.elems) {
        child(elem);
      }
      return;
    case IrKind.TupleGet:
      line(` index=${expr.index}`);
      child(expr.x);
      return;
    case IrKind.FieldGet:
      line(` .${expr.field}`);
      child(expr.x);
      return;
    case IrKind.IfExpr:
      line('');
      child(expr.cond, 'cond: ');
      child(expr.then, 'then: ');
      if (expr.else !== null) {
        child(expr.else, 'else: ');
      }
      return;
    case IrKind.SwitchExpr:
      line('');
      if (expr.subject !== null) {
        child(expr.subject, 'subject: ');
      }
      expr.arms.forEach((arm, i) => {
        if (arm.pattern !== null) {
          child(arm.pattern, `arm[${i}].pattern: `);
        }
        child(arm.body, `arm[${i}].body: `);
      });
      return;
    case IrKind.ForExpr:
      line(` index=${labels.name(expr.index)}`);
      child(expr.from, 'from: ');
      child(expr.to, 'to: ');
      if (expr.step !== null) {
        child(expr.step, 'step: ');
      }
      child(expr.body, 'body: ');
      return;
    case IrKind.ForInExpr:
      line(` targets=${expr.targets.map(t => labels.name(t)).join(',')}`);
      child(expr.x, 'x: ');
      child(expr.body, 'body: ');
      return;
    case IrKind.WhileExpr:
      line('');
      child(expr.cond, 'cond: ');
      child(expr.body, 'body: ');
      return;
    case IrKind.BlockExpr: {
      line('');
      for (const stmt of expr.stmts) {
        dumpStmt(stmt, '', `${indent}  `, out, labels);
      }
      if (expr.value !== null) {
        child(expr.value, 'value: ');
      }
      return;
    }
    default:
      return fatal(`unhandled IR expression in dump: ${JSON.stringify(expr)}`);
  }
}
