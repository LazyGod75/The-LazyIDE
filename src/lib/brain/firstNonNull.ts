/* firstNonNull — race promises; first non-null wins.

   Used by brainGraphLoad so a hanging Tauri invoke does not delay the
   HTTP sidecar fallback for the full timeout window. Null / reject are
   misses; an empty graph object is a hit (honest empty vault).
*/

export function firstNonNull<T>(jobs: Array<Promise<T | null>>): Promise<T | null> {
  if (jobs.length === 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    let left = jobs.length;
    const miss = () => {
      left -= 1;
      if (left === 0) resolve(null);
    };
    for (const job of jobs) {
      job.then((value) => {
        if (value !== null) resolve(value);
        else miss();
      }, miss);
    }
  });
}
