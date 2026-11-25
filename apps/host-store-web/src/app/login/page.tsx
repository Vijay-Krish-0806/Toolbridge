import { signIn } from '../../lib/actions';

/** The host store's own sign-in (its staff accounts), not a ToolBridge login. */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <form
      action={signIn}
      className="mx-auto mt-10 max-w-sm space-y-4 rounded-xl border border-slate-200 bg-white p-6"
    >
      <h1 className="text-lg font-semibold">Sign in</h1>
      {error && <p className="text-sm text-red-700">Wrong email or password.</p>}
      <label className="block text-sm">
        Email
        <select name="email" className="mt-1 block w-full rounded-lg border border-slate-300 p-2">
          <option>owner@store.example</option>
          <option>support@store.example</option>
          <option>warehouse@store.example</option>
        </select>
      </label>
      <label className="block text-sm">
        Password
        <input
          name="password"
          type="password"
          required
          className="mt-1 block w-full rounded-lg border border-slate-300 p-2"
        />
      </label>
      <button className="w-full rounded-lg bg-teal-700 py-2 font-medium text-white hover:bg-teal-800">
        Sign in
      </button>
      <p className="text-xs text-slate-500">
        Demo staff accounts; the password is SEED_STAFF_PASSWORD from .env.
      </p>
    </form>
  );
}
