export type PrefetchEvent<T> =
  | { index: number; chunk: T }
  | { index: number; done: true };

type Slot<T> = {
  items: T[];
  done: boolean;
  failed: boolean;
  error: unknown;
  wake: (() => void) | null;
};

/**
 * Consume `count` streams strictly in order while up to `lookahead` later
 * streams download in parallel. Each stream's chunks are yielded as they
 * arrive, followed by a `done` marker. A failure in a prefetched stream
 * surfaces only when the consumer reaches it. Callers stop in-flight
 * downloads through their own abort signal.
 */
export async function* prefetchInOrder<T>(
  count: number,
  open: (index: number) => AsyncIterable<T>,
  lookahead: number,
): AsyncGenerator<PrefetchEvent<T>, void, unknown> {
  const slots: (Slot<T> | undefined)[] = [];
  const ahead = Math.max(0, Math.floor(lookahead));

  const start = (index: number) => {
    if (index >= count || slots[index]) return;
    const slot: Slot<T> = {
      items: [],
      done: false,
      failed: false,
      error: undefined,
      wake: null,
    };
    slots[index] = slot;
    const notify = () => {
      const wake = slot.wake;
      slot.wake = null;
      wake?.();
    };
    void (async () => {
      try {
        for await (const item of open(index)) {
          slot.items.push(item);
          notify();
        }
      } catch (error) {
        slot.failed = true;
        slot.error = error;
      } finally {
        slot.done = true;
        notify();
      }
    })();
  };

  for (let index = 0; index < count; index++) {
    for (let next = index; next <= index + ahead; next++) start(next);
    const slot = slots[index]!;
    while (true) {
      while (slot.items.length > 0) {
        yield { index, chunk: slot.items.shift()! };
      }
      if (slot.done) break;
      await new Promise<void>((resolve) => {
        slot.wake = resolve;
      });
    }
    slots[index] = undefined;
    if (slot.failed) throw slot.error;
    yield { index, done: true };
  }
}
