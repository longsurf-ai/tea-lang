import type {Observable} from 'rxjs';
import * as z from 'zod';
import {IrKind, type IrExpr} from '../ir/node';
import type {Program, RequestEdge} from '../ir/program';
import {TypeKind, type Type} from '../ir/type';
import {seriesInputsOf} from '../ir/visit';

export type Binding =
  | {
      readonly kind: 'series';
      readonly name: string;
      readonly type: z.ZodType;
      target?: Observable<unknown>;
    }
  | {
      readonly kind: 'parameter';
      readonly name: string;
      readonly type: z.ZodType;
      target?: unknown;
    };

type Pair<A, B> = [A, B];

/**
 * Extract input and output bindings from a Program.
 *
 * Inputs contain the Program's declared parameters, context series, and
 * recursive request contexts. Output channels are series bindings.
 */
export function extract(program: Program): Pair<Binding[], Binding[]> {
  const schemas = new Map<Type, z.ZodType>();
  return [
    inputBindingsOf(program, schemas),
    outputBindingsOf(program, schemas),
  ];
}

function inputBindingsOf(
  program: Program,
  schemas: Map<Type, z.ZodType>,
): Binding[] {
  const bindings: Binding[] = [
    ...program.params.map<Binding>(parameter => ({
      kind: 'parameter',
      name: parameter.name,
      type: schemaOf(parameter.type, schemas),
    })),
    ...seriesInputsOf(program).map<Binding>(series => ({
      kind: 'series',
      name: series.id,
      type: schemaOf(series.type, schemas),
    })),
  ];

  for (const request of program.requests) {
    const type = schemaOf(request.resultType, schemas);
    const children = inputBindingsOf(request.child, schemas);
    bindings.push({
      kind: 'series',
      name: requestName(request),
      type,
      ...(children.length === 0 ? {} : {children}),
    });
  }

  return bindings;
}

function outputBindingsOf(
  program: Program,
  schemas: Map<Type, z.ZodType>,
): Binding[] {
  return program.outputs.flatMap((output, outputId) => {
    const prefix = `${output.effect}[${outputId}]`;
    const qualifyChannel = output.channels.length > 1;
    return output.channels.map<Binding>(channel => ({
      kind: 'series',
      name: qualifyChannel ? `${prefix}.${channel.name}` : prefix,
      type: schemaOf(channel.type, schemas),
    }));
  });
}

function requestName(request: RequestEdge): string {
  const symbol = constantString(request.symbol);
  return symbol === null || symbol === ''
    ? `request@${request.pos.line}:${request.pos.col}`
    : symbol;
}

function constantString(expr: IrExpr): string | null {
  return expr.kind === IrKind.Const && typeof expr.value === 'string'
    ? expr.value
    : null;
}

function schemaOf(type: Type, schemas: Map<Type, z.ZodType>): z.ZodType {
  const existing = schemas.get(type);
  if (existing !== undefined) {
    return existing;
  }

  let schema: z.ZodType;
  switch (type.kind) {
    case TypeKind.Int:
      schema = z.union([z.number().int(), z.nan()]);
      break;
    case TypeKind.Float:
      schema = z.union([z.number(), z.nan()]);
      break;
    case TypeKind.Bool:
      schema = z.boolean();
      break;
    case TypeKind.String:
    case TypeKind.Color:
      schema = z.string().nullable();
      break;
    case TypeKind.Enum: {
      const members = type.members.map(member => member.name);
      schema = (
        members.length === 0
          ? z.never()
          : z.enum(members as [string, ...string[]])
      ).nullable();
      break;
    }
    case TypeKind.Array:
      schema = z.array(schemaOf(type.elem, schemas)).nullable();
      break;
    case TypeKind.Matrix:
      schema = z.array(z.array(schemaOf(type.elem, schemas))).nullable();
      break;
    case TypeKind.Map:
      schema = z
        .map(schemaOf(type.key, schemas), schemaOf(type.value, schemas))
        .nullable();
      break;
    case TypeKind.Struct:
      // Structs may be recursive through collections, so install the lazy
      // schema in the identity cache before visiting their fields.
      schema = z.lazy(() =>
        z
          .object(
            Object.fromEntries(
              type.fields.map(field => [
                field.name,
                schemaOf(field.type, schemas),
              ]),
            ),
          )
          .nullable(),
      );
      schemas.set(type, schema);
      return schema;
    case TypeKind.Tuple: {
      const elements = type.elems.map(elem => schemaOf(elem, schemas));
      schema = (
        elements.length === 0
          ? z.tuple([])
          : z.tuple(elements as [z.ZodType, ...z.ZodType[]])
      ).nullable();
      break;
    }
    case TypeKind.Line:
    case TypeKind.Label:
    case TypeKind.Box:
    case TypeKind.Table:
    case TypeKind.Polyline:
    case TypeKind.Linefill:
      schema = z
        .object({
          kind: z.literal('resource'),
          handle: z.literal(type.kind),
          id: z.number().int(),
        })
        .nullable();
      break;
    case TypeKind.Na:
      schema = z.union([z.nan(), z.null()]);
      break;
    case TypeKind.Invalid:
    case TypeKind.Void:
    case TypeKind.Plot:
    case TypeKind.Hline:
    case TypeKind.Func:
      schema = z.never();
      break;
  }

  schemas.set(type, schema);
  return schema;
}
