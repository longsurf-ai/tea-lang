// Purpose: In-memory OutputSink for generic batch callers that need structured dense output.

import type {
  DeclaredOutput,
  EffectEmission,
  EffectSpec,
  EffectValue,
  OutputSink,
  RowPublication,
  Value,
} from '../../runtime/abi';

export type MemoryOutput = DeclaredOutput;

export interface MemoryEmission {
  readonly row: number;
  readonly outputId: number;
  readonly channels: readonly Value[];
  readonly provisional: boolean;
}

export interface MemoryEffectEmission extends EffectEmission {
  readonly row: number;
  readonly provisional: boolean;
}

function cloneTransport(
  transport: MemoryOutput['spec']['channels'][number]['transport'],
): MemoryOutput['spec']['channels'][number]['transport'] {
  if (transport.kind === 'enum') {
    return {...transport, members: [...transport.members]};
  }
  return {...transport};
}

function cloneOutput(output: MemoryOutput): MemoryOutput {
  return {
    spec: {
      ...output.spec,
      staticArgs: output.spec.staticArgs.map(arg => ({...arg})),
      channels: output.spec.channels.map(channel => ({
        ...channel,
        transport: cloneTransport(channel.transport),
      })),
    },
    boundArgs: output.boundArgs.map(arg => ({...arg})),
  };
}

function cloneEffectPayload(value: EffectValue): EffectValue {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  return Object.freeze({
    kind: 'user-type' as const,
    fields: Object.freeze(value.fields.map(cloneEffectPayload)),
  });
}

function cloneEffectSchema(
  schema: EffectSpec['payload'],
): EffectSpec['payload'] {
  switch (schema.kind) {
    case 'enum':
      return {...schema, members: schema.members.map(member => ({...member}))};
    case 'user-type':
      return {
        ...schema,
        fields: schema.fields.map(field => ({
          name: field.name,
          value: cloneEffectSchema(field.value),
        })),
      };
    default:
      return {...schema};
  }
}

export class MemorySink implements OutputSink {
  readonly outputs: MemoryOutput[] = [];
  readonly effectSchemas: EffectSpec[] = [];
  readonly emissions: MemoryEmission[] = [];
  readonly effectEmissions: MemoryEffectEmission[] = [];
  readonly publications: RowPublication[] = [];

  declare(declaration: Parameters<OutputSink['declare']>[0]): void {
    this.outputs.splice(
      0,
      this.outputs.length,
      ...declaration.outputs.map(cloneOutput),
    );
    this.effectSchemas.splice(
      0,
      this.effectSchemas.length,
      ...declaration.effects.map(effect => ({
        payload: cloneEffectSchema(effect.payload),
      })),
    );
  }

  publish(publication: RowPublication): void {
    const cloned: RowPublication = {
      row: publication.row,
      ...(publication.time === undefined ? {} : {time: publication.time}),
      outputs: publication.outputs.map(output => ({
        outputId: output.outputId,
        channels: [...output.channels],
      })),
      effects: publication.effects.map(effect => ({
        effectId: effect.effectId,
        payload: cloneEffectPayload(effect.payload),
      })),
      provisional: publication.provisional,
    };
    this.publications.push(cloned);
    for (const output of cloned.outputs) {
      this.emissions.push({
        row: cloned.row,
        outputId: output.outputId,
        channels: output.channels,
        provisional: cloned.provisional,
      });
    }
    for (const effect of cloned.effects) {
      this.effectEmissions.push({
        row: cloned.row,
        effectId: effect.effectId,
        payload: effect.payload,
        provisional: cloned.provisional,
      });
    }
  }
}
