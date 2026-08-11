# Tea struct methods and implicit `this`

## 1. System map

```text
SOURCE
+-------------------------------+
| struct Portfolio              |  `type Portfolio` is identical
|   array<int> lots             |
|   int add(int qty) =>         |  implicit mutable `this`
|     this.lots.push(qty)       |
|   int size() const => ...     |  implicit read-only `this`
+-------------------------------+
                |
                v
Syntax UserTypeDecl { writtenKeyword, members }
                |
                v
Checker UserTypeObject + owned methods + synthetic receiver place
                |
                v
Program hidden receiver ----> existing capture/call/writeback protocol
                |
                v
Runtime immutable values + COW history (unchanged)

FUTURE: type Alias = Portfolio     FUTURE: first-class *Portfolio
        reserved, not implemented         separate language proposal
```

- `docs/memory-model.md` remains the authority: variables, arguments, returns,
  fields, collection elements, and history still carry user-defined values.
- A method's nesting supplies an implicit receiver. It is mutable by default;
  trailing `const` makes the receiver read-only. Receiver mode is therefore a
  declared signature fact, never inferred from the body.
- `this` is a non-escaping, compiler-only receiver pointer/place capability.
  V1 permits `this.field` and `this.method(...)`, but not storing, returning,
  comparing, dereferencing, history-indexing, or passing bare `this`.
- Both block-form `struct Foo` and `type Foo` create the same fresh nominal
  `UserType`. Only `type Foo = Bar` is reserved for a future transparent alias.

## 2. Problem

Tea currently expresses methods as top-level `method` declarations whose first
source parameter is an optional `inout` receiver. That choice is embedded in
`FuncDecl.method`, `Param.mode`, checker method resolution, and the Program's
copy-in/copy-out function contract. It does not match the desired OOP surface,
and it exposes an implementation mechanism in every method signature.

Replace that source model without changing value copying, historical snapshots,
collection COW, or atomic receiver writeback. This is a breaking syntax change:
top-level `method` and source `inout` are removed rather than supported as a
second declaration model. User-defined extension methods on collection types
are deferred; catalog-owned collection methods remain unchanged. Top-level
free functions keep their current inferred-result syntax.

## 3. Implementation

1. **Lock the source-observable receiver contract** — `packages/tea-lang/docs/memory-model.md`, `docs/{ir,conformance}.md`
   - Specify default mutable and trailing-`const` methods, rooted-place
     requirements, read-only calls on temporaries/history, non-escaping `this`,
     success-only single writeback, and unchanged value/history isolation.
   - Add a short supersession link from the receiver sections of
     `plans/20260809-tea-collection-user-types-heap.md`; its Heap and collection
     design remains valid.

2. **Represent the new grammar without legacy boolean states** — `src/syntax/{tokens,nodes,parser,dumper}.ts`, editor grammar
   - Add contextual `struct`, reserved `this`, and a dedicated `ThisExpr`.
     Remove `method` declaration parsing and source `ParamMode.Inout`.
   - Rename `TypeDecl` to `UserTypeDecl` with
     `writtenKeyword: 'struct' | 'type'` and source-ordered field/method members.
     Add a distinct `MethodDecl` with explicit result type, explicitly typed
     parameters, and `receiverMode: 'mutable' | 'const'`; no receiver parameter
     appears in source.
   - Parse `type Name = Type` as a reserved alias production that receives one
     stable "not implemented" checker diagnostic. `struct Name = Type` is
     always invalid. Field indices ignore interleaved methods.

3. **Make the enclosing user type the method owner** — `src/checker/{object,scope,check,binding,info}.ts`
   - Keep one canonical `FunctionObject` per method, record its
     `UserTypeObject` owner and receiver mode, and use `Scope` only as its lookup
     index. Reject duplicate field/method names and duplicate methods per owner.
   - Synthesize one receiver `VariableObject` per `FunctionInstance`; bind each
     `ThisExpr` to it in that instance's `Info`. Mutable methods may update it;
     `const` methods reject field writes, collection mutators, and mutable nested
     method calls.
   - Validate the declared result type against the body. Mutable calls require
     a current writable root/path; `const` calls accept roots, constructor
     results, collection getters, and historical values. Bare `this` never
     acquires a public `PointerType`.
   - Validate every method body at declaration publication, including methods
     with no call sites. Method defaults are caller-side declaration-scope
     expressions and may not refer to `this` or any parameter of that method;
     reject those dependencies before any call can reach noder/codegen.

4. **Project an explicit hidden receiver** — `src/noder`, `src/ir`, `src/codegen`
   - Exclude the receiver from source argument/default/named-argument ordering,
     but preserve it as a separate Program receiver `Name` evaluated before all
     explicit arguments.
   - Rename user-function `Inout*` contracts to mutable-method terminology and
     represent free functions, const methods, and mutable methods as an
     exhaustive discriminated union. Reuse the existing mutable call envelope:
     capture caller path/value once, execute, return replacement receiver, then
     rebase and write once on success.
   - Keep ABI 3, Heap, Rings, request sharing, suspension, and publication
     unchanged; no runtime address, `StorageRef`, pointer equality, or lifetime
     system is introduced.

5. **Migrate language-owned examples and invariants** — examples, fixtures,
   owning `AGENTS.md` files
   - Rewrite current `method ... (inout Foo self, ...)` examples/tests to nested
     methods using `this`; cover both `struct` and block-form `type` spellings.
   - Document that constructors remain `Foo.new`, nested methods are instance
     methods only, and first-class pointers/type aliases remain separate work.

## 4. Verification

- [x] Parser/dumper/editor tests recognize interleaved fields and methods under
      both spellings, explicit result types, trailing `const`, and `ThisExpr`.
- [x] Compile-fail tests reject legacy `method`/source `inout`, `this` outside a
      method, escaping bare `this`, mutation in a `const` method, mutable calls
      on temporaries/history, `struct Alias = T`, and unsupported `type Alias = T`.
- [x] Checker ownership tests prove both declaration spellings create the same
      semantic kind, each nested method has exactly one owner/receiver, and
      declared return types and duplicate names fail at the owner. Uncalled
      methods are declaration-checked, and defaults depending on `this` or a
      method parameter are rejected before lowering.
- [x] Noder/codegen tests prove receiver-first evaluation, source-ordered
      explicit arguments, nested `this.child.mutate()` rebasing, and no
      receiver entry in named/default argument metadata.
- [x] End-to-end Tea conformance proves `b = a; b.add(1)` leaves `a` and `a[1]`
      unchanged, `a[1].size()` is legal, and throw/suspension performs no
      receiver writeback.
- [x] Run package typecheck/tests, docs build, VS Code checks, Tea-wide
      lint/format, example compilation, and `git diff --check`.
- [ ] Run `just check` before opening a PR; the current worktree contains
      unrelated changes and this task does not open a PR.
