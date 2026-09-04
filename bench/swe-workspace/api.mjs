// Callback-based fetchData — refactor to async/await
export function fetchData(url, callback) {
  setTimeout(() => {
    if (url.includes('error')) {
      callback(new Error('Network error'), null);
    } else {
      callback(null, { url, data: 'response-' + url });
    }
  }, 10);
}
