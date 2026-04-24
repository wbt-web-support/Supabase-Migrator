export function pLimit(concurrency: number) {
  const queue: Array<() => void> = [];
  let active = 0;

  const runNext = () => {
    active -= 1;
    const next = queue.shift();
    if (next) {
      active += 1;
      next();
    }
  };

  return function run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task = () => {
        fn().then(resolve, reject).finally(runNext);
      };
      if (active < concurrency) {
        active += 1;
        task();
      } else {
        queue.push(task);
      }
    });
  };
}
