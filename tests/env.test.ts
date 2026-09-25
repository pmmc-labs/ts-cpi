import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Env, Value } from '../src/types.ts';
import {
  emptyEnv,
  fromBindings,
  required,
  compose,
  composeModule,
  lookup,
  conflicts,
  bindingHash,
} from '../src/env.ts';
import { NIL, TRUE, FALSE, sym, int, float, str, list } from '../src/values.ts';

test('emptyEnv creates an empty environment', () => {
  const env = emptyEnv();
  assert.deepEqual(env.slots.size, 0);
});

test('required creates an environment with a required slot', () => {
  const env = required('foo');
  assert.equal(env.slots.size, 1);
  const slot = env.slots.get('foo');
  assert.notEqual(slot, undefined);
  assert.equal(slot!.s, 'required');
  assert.equal(slot!.name, 'foo');
});

test('fromBindings creates an environment with defined slots', () => {
  const env = fromBindings([
    ['foo', int(42n)],
    ['bar', str('hello')],
  ]);
  assert.equal(env.slots.size, 2);

  const fooSlot = env.slots.get('foo');
  assert.notEqual(fooSlot, undefined);
  assert.equal(fooSlot!.s, 'defined');
  assert.deepEqual((fooSlot as any).value, int(42n));

  const barSlot = env.slots.get('bar');
  assert.notEqual(barSlot, undefined);
  assert.equal(barSlot!.s, 'defined');
  assert.deepEqual((barSlot as any).value, str('hello'));
});

test('compose: required is identity', () => {
  const env1 = fromBindings([['foo', int(42n)]]);
  const req = required('bar');

  // compose(required, defined) = defined
  const result1 = compose(req, env1);
  assert.equal(result1.slots.size, 2);
  assert.equal(result1.slots.get('foo')!.s, 'defined');
  assert.equal(result1.slots.get('bar')!.s, 'required');

  // compose(defined, required) = defined
  const result2 = compose(env1, req);
  assert.equal(result2.slots.size, 2);
  assert.equal(result2.slots.get('foo')!.s, 'defined');
  assert.equal(result2.slots.get('bar')!.s, 'required');
});

test('compose: identical defined slots stay defined', () => {
  const env1 = fromBindings([['foo', int(42n)]]);
  const env2 = fromBindings([['foo', int(42n)]]);

  const result = compose(env1, env2);
  assert.equal(result.slots.size, 1);
  const slot = result.slots.get('foo');
  assert.equal(slot!.s, 'defined');
  assert.deepEqual((slot as any).value, int(42n));
});

test('compose: different defined slots become conflicted', () => {
  const env1 = fromBindings([['foo', int(42n)]]);
  const env2 = fromBindings([['foo', int(99n)]]);

  const result = compose(env1, env2);
  assert.equal(result.slots.size, 1);
  const slot = result.slots.get('foo');
  assert.equal(slot!.s, 'conflicted');
  assert.equal((slot as any).left.s, 'defined');
  assert.equal((slot as any).right.s, 'defined');
});

test('compose: identical atoms are equal', () => {
  // Test bool, nil, int, float, str, sym
  const env1 = fromBindings([
    ['b1', TRUE],
    ['b2', FALSE],
    ['n', NIL],
    ['i', int(42n)],
    ['f', float(3.14)],
    ['s', str('hello')],
    ['sy', sym('foo')],
  ]);
  const env2 = fromBindings([
    ['b1', TRUE],
    ['b2', FALSE],
    ['n', NIL],
    ['i', int(42n)],
    ['f', float(3.14)],
    ['s', str('hello')],
    ['sy', sym('foo')],
  ]);

  const result = compose(env1, env2);
  assert.equal(result.slots.size, 7);
  for (const [name, slot] of result.slots) {
    assert.equal(slot.s, 'defined', `slot ${name} should be defined, not ${slot.s}`);
  }
});

test('compose: different atoms become conflicted', () => {
  const env1 = fromBindings([
    ['i1', int(42n)],
    ['i2', int(42n)],
    ['f1', float(3.14)],
    ['s1', str('hello')],
  ]);
  const env2 = fromBindings([
    ['i1', int(99n)],
    ['i2', int(42n)],
    ['f1', float(2.71)],
    ['s1', str('world')],
  ]);

  const result = compose(env1, env2);

  // i1: different ints -> conflicted
  assert.equal(result.slots.get('i1')!.s, 'conflicted');

  // i2: same ints -> defined
  assert.equal(result.slots.get('i2')!.s, 'defined');

  // f1: different floats -> conflicted
  assert.equal(result.slots.get('f1')!.s, 'conflicted');

  // s1: different strings -> conflicted
  assert.equal(result.slots.get('s1')!.s, 'conflicted');
});

test('compose: recursion into conflicted slots', () => {
  const env1 = fromBindings([['foo', int(1n)]]);
  const env2 = fromBindings([['foo', int(2n)]]);
  const env3 = fromBindings([['foo', int(3n)]]);

  // Compose env1 and env2 to create conflicted slot
  const conflicted = compose(env1, env2);
  assert.equal(conflicted.slots.get('foo')!.s, 'conflicted');

  // Compose the conflicted result with env3
  const result = compose(conflicted, env3);
  const slot = result.slots.get('foo');
  assert.equal(slot!.s, 'conflicted');

  // The left should still be env1's value
  assert.equal((slot as any).left.s, 'defined');
  assert.deepEqual((slot as any).left.value, int(1n));

  // The right should be a conflicted of env2 and env3
  const rightSlot = (slot as any).right;
  assert.equal(rightSlot.s, 'conflicted');
  assert.deepEqual((rightSlot as any).left.value, int(2n));
  assert.deepEqual((rightSlot as any).right.value, int(3n));
});

test('lookup: defined slots return their value', () => {
  const env = fromBindings([
    ['foo', int(42n)],
    ['bar', str('hello')],
  ]);

  assert.deepEqual(lookup(env, 'foo'), int(42n));
  assert.deepEqual(lookup(env, 'bar'), str('hello'));
});

test('lookup: required slots return null', () => {
  const env = required('foo');
  assert.equal(lookup(env, 'foo'), null);
});

test('lookup: undefined names return null', () => {
  const env = fromBindings([['foo', int(42n)]]);
  assert.equal(lookup(env, 'bar'), null);
});

test('lookup: scope rule - right shadows left', () => {
  const env1 = fromBindings([['foo', int(1n)]]);
  const env2 = fromBindings([['foo', int(2n)]]);
  const result = compose(env1, env2);

  // Right (env2) shadows left (env1)
  assert.deepEqual(lookup(result, 'foo'), int(2n));
});

test('lookup: conflicted slot resolves to right side', () => {
  const env1 = fromBindings([['foo', int(1n)]]);
  const env2 = fromBindings([['foo', int(2n)]]);
  const conflicted = compose(env1, env2);

  // Should resolve to the right side (env2)
  assert.deepEqual(lookup(conflicted, 'foo'), int(2n));
});

test('lookup: recursive resolution in conflicted slots', () => {
  const env1 = fromBindings([['foo', int(1n)]]);
  const env2 = fromBindings([['foo', int(2n)]]);
  const env3 = fromBindings([['foo', int(3n)]]);

  const conflicted = compose(env1, env2);
  const result = compose(conflicted, env3);

  // Should resolve to the rightmost value
  assert.deepEqual(lookup(result, 'foo'), int(3n));
});

test('conflicts: returns names of conflicted slots', () => {
  const env1 = fromBindings([
    ['foo', int(1n)],
    ['bar', int(2n)],
    ['baz', int(3n)],
  ]);
  const env2 = fromBindings([
    ['foo', int(10n)],
    ['baz', int(30n)],
  ]);

  const result = compose(env1, env2);
  const conflictNames = conflicts(result);

  assert.equal(conflictNames.length, 2);
  assert(conflictNames.includes('foo'));
  assert(conflictNames.includes('baz'));
});

test('conflicts: empty for no conflicts', () => {
  const env = fromBindings([['foo', int(42n)]]);
  assert.deepEqual(conflicts(env), []);
});

test('composeModule: succeeds when no new conflicts', () => {
  const env1 = fromBindings([['foo', int(1n)]]);
  const env2 = fromBindings([['bar', int(2n)]]);

  const result = composeModule(env1, env2);
  assert.equal(result.ok, true);
  assert.equal((result as any).env.slots.size, 2);
});

test('composeModule: fails when new conflicts are created', () => {
  const env1 = fromBindings([['foo', int(1n)]]);
  const env2 = fromBindings([['foo', int(2n)]]);

  const result = composeModule(env1, env2);
  assert.equal(result.ok, false);
  assert(Array.isArray((result as any).conflicts));
  assert((result as any).conflicts.includes('foo'));
});

test('composeModule: allows existing conflicts', () => {
  const env1 = fromBindings([['foo', int(1n)]]);
  const env2 = fromBindings([['foo', int(2n)]]);
  const conflicted = compose(env1, env2);

  // Now compose this conflicted env with another env that resolves it or is compatible
  const env3 = emptyEnv();
  const result = composeModule(conflicted, env3);
  assert.equal(result.ok, true);
});

test('composeModule: fails when composing with new conflicts in existing conflicts', () => {
  const env1 = fromBindings([['foo', int(1n)]]);
  const env2 = fromBindings([['foo', int(2n)]]);
  const conflicted = compose(env1, env2);

  // Compose with a conflicting value that creates a NEW conflicted slot deeper
  const env3 = fromBindings([['foo', int(3n)]]);
  const result = composeModule(conflicted, env3);

  // A third, different definition is a new conflict under the module rule.
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.conflicts, ['foo']);

  // Re-adding the definition that already wins adds nothing, so it is allowed.
  assert.equal(composeModule(conflicted, env2).ok, true);
});

test('bindingHash: same resolved bindings produce same hash', () => {
  const env1 = fromBindings([
    ['foo', int(42n)],
    ['bar', str('hello')],
  ]);
  const env2 = fromBindings([
    ['foo', int(42n)],
    ['bar', str('hello')],
  ]);

  const printValue = (v: Value): string => {
    if (v.t === 'int') return `int:${v.v}`;
    if (v.t === 'str') return `str:${v.v}`;
    return 'unknown';
  };

  const hash1 = bindingHash(env1, printValue);
  const hash2 = bindingHash(env2, printValue);

  assert.equal(hash1, hash2);
});

test('bindingHash: different bindings produce different hashes', () => {
  const env1 = fromBindings([['foo', int(42n)]]);
  const env2 = fromBindings([['foo', int(99n)]]);

  const printValue = (v: Value): string => {
    if (v.t === 'int') return `int:${v.v}`;
    return 'unknown';
  };

  const hash1 = bindingHash(env1, printValue);
  const hash2 = bindingHash(env2, printValue);

  assert.notEqual(hash1, hash2);
});

test('bindingHash: order independent for same names', () => {
  // Create two environments with names in different order
  const env1 = fromBindings([
    ['aaa', int(1n)],
    ['zzz', int(2n)],
  ]);
  const env2 = fromBindings([
    ['zzz', int(2n)],
    ['aaa', int(1n)],
  ]);

  const printValue = (v: Value): string => {
    if (v.t === 'int') return `int:${v.v}`;
    return 'unknown';
  };

  const hash1 = bindingHash(env1, printValue);
  const hash2 = bindingHash(env2, printValue);

  // Should be the same because hashing is done on sorted names
  assert.equal(hash1, hash2);
});

test('bindingHash: ignores required slots and conflicted slots', () => {
  const env1 = fromBindings([['foo', int(42n)]]);
  const env2 = required('bar');
  const composed = compose(env1, env2);

  const env3 = fromBindings([['foo', int(42n)]]);

  const printValue = (v: Value): string => {
    if (v.t === 'int') return `int:${v.v}`;
    return 'unknown';
  };

  const hash1 = bindingHash(composed, printValue);
  const hash2 = bindingHash(env3, printValue);

  // Should be the same because we ignore required
  assert.equal(hash1, hash2);
});

test('bindingHash: ignores conflicted slots', () => {
  const env1 = fromBindings([
    ['foo', int(1n)],
    ['bar', int(2n)],
  ]);
  const env2 = fromBindings([
    ['foo', int(10n)],
  ]);
  const conflicted = compose(env1, env2);

  // The hash should only consider the resolved values (right side wins)
  const env3 = fromBindings([
    ['foo', int(10n)],
    ['bar', int(2n)],
  ]);

  const printValue = (v: Value): string => {
    if (v.t === 'int') return `int:${v.v}`;
    return 'unknown';
  };

  const hash1 = bindingHash(conflicted, printValue);
  const hash2 = bindingHash(env3, printValue);

  assert.equal(hash1, hash2);
});

test('compose with conflicted on right side', () => {
  const env1 = fromBindings([['foo', int(1n)]]);
  const env2 = fromBindings([['foo', int(2n)]]);
  const conflicted = compose(env1, env2);  // conflicted(1, 2)
  
  // Now compose another environment with the conflicted one
  const env3 = fromBindings([['foo', int(3n)]]);
  const result = compose(env3, conflicted);
  
  // This should compose 3 with conflicted(1, 2)
  const slot = result.slots.get('foo');
  assert.equal(slot!.s, 'conflicted');
});

test('compose: multiple names with mixed conflicts', () => {
  const env1 = fromBindings([
    ['a', int(1n)],
    ['b', int(2n)],
    ['c', int(3n)],
  ]);
  const env2 = fromBindings([
    ['a', int(1n)],  // same as env1
    ['b', int(20n)], // different from env1
    ['d', int(4n)],  // new name
  ]);
  
  const result = compose(env1, env2);
  
  // 'a': identical, should be defined
  assert.equal(result.slots.get('a')!.s, 'defined');
  
  // 'b': different, should be conflicted
  assert.equal(result.slots.get('b')!.s, 'conflicted');
  
  // 'c': only in left, should be defined
  assert.equal(result.slots.get('c')!.s, 'defined');
  
  // 'd': only in right, should be defined
  assert.equal(result.slots.get('d')!.s, 'defined');
});
