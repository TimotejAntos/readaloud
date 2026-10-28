// iPhone Safari cannot "for await" over a ReadableStream yet, and PDF.js
// reads every page's text that way. This adds the missing iterator.
if (typeof ReadableStream !== "undefined" && !ReadableStream.prototype[Symbol.asyncIterator]) {
  ReadableStream.prototype.values = function ({ preventCancel = false } = {}) {
    const reader = this.getReader();
    return {
      next: () => reader.read(),
      async return(value) {
        if (preventCancel) reader.releaseLock();
        else {
          const done = reader.cancel(value);
          reader.releaseLock();
          await done;
        }
        return { done: true, value };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  };
  ReadableStream.prototype[Symbol.asyncIterator] = ReadableStream.prototype.values;
}
