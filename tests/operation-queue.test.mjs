import assert from "node:assert/strict";
import test from "node:test";

import { OperationQueue } from "../dist/engine/operationQueue.js";

test("operation queue runs tasks serially", async () => {
  const queue = new OperationQueue();
  const events = [];
  const firstStarted = deferred();
  const releaseFirst = deferred();

  const first = queue.enqueue({
    label: "first",
    run: async () => {
      events.push("first:start");
      firstStarted.resolve();
      await releaseFirst.promise;
      events.push("first:end");
      return 1;
    },
  });

  await firstStarted.promise;

  const second = queue.enqueue({
    label: "second",
    run: async () => {
      events.push("second:start");
      return 2;
    },
  });

  await Promise.resolve();
  assert.deepEqual(events, ["first:start"]);

  releaseFirst.resolve();

  assert.equal(await first, 1);
  assert.equal(await second, 2);
  assert.deepEqual(events, ["first:start", "first:end", "second:start"]);
});

test("operation queue continues after a failed task", async () => {
  const queue = new OperationQueue();
  const events = [];

  await assert.rejects(
    queue.enqueue({
      label: "fails",
      run: async () => {
        events.push("fails");
        throw new Error("boom");
      },
    }),
    /boom/,
  );

  const result = await queue.enqueue({
    label: "next",
    run: async () => {
      events.push("next");
      return "ok";
    },
  });

  assert.equal(result, "ok");
  assert.deepEqual(events, ["fails", "next"]);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
