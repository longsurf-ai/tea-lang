// Purpose: Persistent checker scope tree mapping source names to canonical semantic declaration objects.

import type {MethodObject, Object} from './object';

export class Scope {
  readonly children: Scope[] = [];
  private readonly objects = new Map<string, Object>();
  private readonly methods = new Map<string, MethodObject[]>();

  constructor(
    readonly parent: Scope | null,
    trackChild = true,
  ) {
    if (trackChild) {
      parent?.children.push(this);
    }
  }

  lookup(name: string): Object | null {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let scope: Scope | null = this;
    while (scope !== null) {
      const object = scope.objects.get(name);
      if (object !== undefined) {
        return object;
      }
      scope = scope.parent;
    }
    return null;
  }

  has(name: string): boolean {
    return this.objects.has(name);
  }

  // True when `name` resolves within the chain from this scope up to and
  // including `boundary` — how the checker decides a write target is local
  // to the current function instantiation.
  resolvesWithin(name: string, boundary: Scope): boolean {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let scope: Scope | null = this;
    while (scope !== null) {
      if (scope.has(name)) {
        return true;
      }
      if (scope === boundary) {
        return false;
      }
      scope = scope.parent;
    }
    return false;
  }

  // Declares into THIS scope; false when the name is already declared here
  // (shadowing an outer scope's name is allowed, redeclaring locally is not).
  declare(object: Object): boolean {
    if (this.objects.has(object.name)) {
      return false;
    }
    this.objects.set(object.name, object);
    return true;
  }

  declareMethod(method: MethodObject): boolean {
    const methods = this.methods.get(method.name);
    if (methods === undefined) {
      this.methods.set(method.name, [method]);
      return true;
    }
    if (
      methods.some(
        candidate => candidate.receiver.owner === method.receiver.owner,
      )
    ) {
      return false;
    }
    methods.push(method);
    return true;
  }

  lookupMethods(name: string): readonly MethodObject[] {
    const methods: MethodObject[] = [];
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let scope: Scope | null = this;
    while (scope !== null) {
      methods.push(...(scope.methods.get(name) ?? []));
      scope = scope.parent;
    }
    return methods;
  }
}
