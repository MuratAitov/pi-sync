export interface QueuedOperation<T> {
  label: string;
  run: () => Promise<T>;
}

export class OperationQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private activeLabel: string | undefined;

  enqueue<T>(operation: QueuedOperation<T>): Promise<T> {
    const runAfterTail = this.tail.catch(() => undefined).then(async () => {
      this.activeLabel = operation.label;
      try {
        return await operation.run();
      } finally {
        this.activeLabel = undefined;
      }
    });

    this.tail = runAfterTail;
    return runAfterTail;
  }

  currentOperation(): string | undefined {
    return this.activeLabel;
  }
}
