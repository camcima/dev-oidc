import { describe, expect, expectTypeOf, it } from 'vitest';
import { ConfigSchema, type Profile } from '@/index.js';

// Enforced by `npm run typecheck` (tsconfig includes tests/): library users'
// v0.8.0 code must keep compiling against the exported Profile type.
describe('exported Profile type', () => {
  it('still accepts a v0.8.0 profile literal with no description', () => {
    const v080: Profile = {
      id: 'alice',
      displayName: 'Alice',
      email: 'alice@example.com',
      avatar: null,
      claims: {},
    };
    expect(ConfigSchema.safeParse).toBeTypeOf('function');
    expectTypeOf(v080).toEqualTypeOf<Profile>();
  });

  it('gains description only as an optional string', () => {
    expectTypeOf<Profile['description']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Omit<Profile, 'description'>>().toExtend<Profile>();
  });
});
