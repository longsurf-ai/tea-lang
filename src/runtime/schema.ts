// Purpose: Target-neutral parameter and effect declarations shared by generated artifacts and hosts.

import type {ParamDisplay} from '../ir/program';
import type {Scalar} from './value';

export type ParamConstraintSpec =
  | {
      readonly kind: 'range';
      readonly minval: number | null;
      readonly maxval: number | null;
      readonly step: number | null;
    }
  | {
      readonly kind: 'options';
      readonly options: readonly Scalar[];
    };

export interface ParamSpec {
  readonly name: string;
  readonly title: string | null;
  readonly type:
    | 'int'
    | 'float'
    | 'bool'
    | 'string'
    | 'color'
    | 'source'
    | 'enum';
  readonly control: string;
  readonly defaultValue: Scalar;
  readonly constraints: ParamConstraintSpec | null;
  readonly enumType: {
    readonly name: string;
    readonly members: readonly {
      readonly name: string;
      readonly title: string;
    }[];
  } | null;
  readonly group: string | null;
  readonly inline: string | null;
  readonly tooltip: string | null;
  readonly confirm: boolean;
  readonly display: ParamDisplay;
  readonly seriesSid: number | null;
}
